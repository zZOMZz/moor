import { sessionReadResponseSchema, validateSessionBundle } from '@moor/protocol/session-responses';
import { decode, delta, LoroDoc, mirror, vv } from './model';
import type { readClientSession, SessionClientScope } from './session-operations';

/** Frozen UI projection. A full CRDT export is available only at an explicit snapshot boundary. */
export type ClientSessionView = Omit<ReturnType<typeof readClientSession>, 'update' | 'version'> & {
  version: string;
};
export type ClientSessionDelta = {
  readonly response: ReturnType<typeof sessionReadResponseSchema.parse>;
  readonly baseVersion?: string;
  readonly version: string;
};

const verifiedDeltas = new WeakMap<object, SessionClientScope>();
const sameScope = (left: SessionClientScope, right: SessionClientScope) =>
  left.userId === right.userId &&
  left.machineId === right.machineId &&
  left.workspaceId === right.workspaceId &&
  left.localProjectId === right.localProjectId &&
  left.sessionId === right.sessionId;

/** Accept only a verified import from this runtime, bound to the exact cache execution scope. */
export function verifiedSessionDelta(
  value: unknown,
  scope: SessionClientScope,
): ClientSessionDelta {
  const origin = value && typeof value === 'object' ? verifiedDeltas.get(value) : undefined;
  if (!origin || !sameScope(origin, scope)) throw Error('会话增量未经当前执行范围验证');
  return value as ClientSessionDelta;
}

/**
 * One active host-authored document and Mirror. Normal reads import only the host
 * delta; unchanged Mirror branches reuse their frozen UI projections. Mirror owns
 * mutable container descriptors, so never freeze or expose its internal objects.
 */
export class ClientSessionReplica {
  readonly scope: SessionClientScope;
  #doc?: LoroDoc;
  #mirror?: ReturnType<typeof mirror>;
  #view?: ClientSessionView;
  #lastRead?: ClientSessionDelta;
  #projections = new WeakMap<object, unknown>();
  #disposed = false;

  constructor(scope: SessionClientScope) {
    this.scope = Object.freeze({
      userId: scope.userId,
      machineId: scope.machineId,
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      sessionId: scope.sessionId,
    });
  }

  get view() {
    return this.#view;
  }

  get lastRead() {
    return this.#lastRead;
  }

  #assertOpen() {
    if (this.#disposed) throw Error('会话副本已释放，请重新读取');
  }

  #project<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    const cached = this.#projections.get(value);
    if (cached !== undefined) return cached as T;
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    this.#projections.set(value, result);
    for (const [key, child] of Object.entries(value))
      Object.defineProperty(result, key, {
        value: this.#project(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return Object.freeze(result) as T;
  }

  /**
   * Hydrate with a full checkpoint first, then replay verified stored deltas in order.
   * A failed import disposes the replica: pending or invalid operations must never be
   * applied by a later read. Previously returned frozen views remain safe to display.
   */
  read(raw: unknown): ClientSessionView {
    this.#assertOpen();
    const response = sessionReadResponseSchema.parse(raw);
    validateSessionBundle(response);
    if (
      response.meta.id !== this.scope.sessionId ||
      response.meta.userId !== this.scope.userId ||
      response.meta.machineId !== this.scope.machineId ||
      response.meta.project.localProjectId !== this.scope.localProjectId
    )
      throw Error('会话响应与原执行范围不匹配');
    const baseVersion = this.#view?.version;
    const doc = (this.#doc ??= new LoroDoc());
    try {
      const imported = doc.import(decode(response.update));
      if (imported.pending?.size) throw Error('会话增量缺少前置版本，请重新读取');
      this.#mirror ??= mirror(doc, this.scope.sessionId);
      const state = this.#mirror.getState();
      if (state.session.id !== this.scope.sessionId) throw Error('会话文档身份不匹配');
      const verifiedResponse = this.#project(response);
      const { update: _update, ...envelope } = verifiedResponse;
      const version = vv(doc);
      const view = Object.freeze({
        ...envelope,
        version,
        history: this.#project(state.history),
      });
      const accepted = Object.freeze({
        response: verifiedResponse,
        ...(baseVersion === undefined ? {} : { baseVersion }),
        version,
      });
      verifiedDeltas.set(accepted, this.scope);
      this.#view = view;
      this.#lastRead = accepted;
      return view;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Full export for compaction or an explicit user command, never for a streaming UI update. */
  exportSnapshot(): ReturnType<typeof readClientSession> {
    this.#assertOpen();
    if (!this.#view || !this.#doc) throw Error('会话副本尚未读取');
    return { ...this.#view, update: delta(this.#doc) };
  }

  #release() {
    this.#mirror?.dispose();
    this.#mirror = undefined;
    this.#doc?.free();
    this.#doc = undefined;
    this.#view = undefined;
    this.#lastRead = undefined;
    this.#projections = new WeakMap();
  }

  /** Discard the current document before hydrating another checkpoint for the same scope. */
  reset() {
    this.#assertOpen();
    this.#release();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
  }
}
