import { actorKey, actorSchema, type AttentionActor } from '@moor/protocol/attention';
import { collaborationReadResponseSchema } from '@moor/protocol/collaboration-protocol';
import { RequestFailure } from '@moor/protocol/request-failure';
import { readClientSession } from '@moor/session/session-operations';
import { z } from 'zod';
import {
  CollaborationClient,
  type CollaborationStorage,
  type CollaborationTransport,
} from './client';
export type CollaborationRead = z.infer<typeof collaborationReadResponseSchema>;
export interface CollaborationPageAccess extends CollaborationTransport {
  readonly owner: string;
  identity(): Promise<{ owner: string | null; actor?: AttentionActor }>;
  read(): Promise<unknown>;
  enable(): Promise<unknown>;
  member(accountId: string, role: 'viewer' | 'operator' | null): Promise<unknown>;
  invite(): Promise<string>;
}
const descriptorSchema = z
  .object({ actor: actorSchema, read: collaborationReadResponseSchema, clientId: z.string() })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
/** One page's scoped cache and authenticated lifetime, independent of UI and transport. */
export class CollaborationPage {
  private closed = false;
  private listeners = new Set<() => void>();
  private actor?: AttentionActor;
  private saved?: Descriptor;
  private readonly key: string;
  constructor(
    private readonly options: {
      owner: string;
      origin: string;
      workspace: string;
      replica: string;
      session: string;
      storage: CollaborationStorage;
      access: CollaborationPageAccess;
      uuid(): string;
      now(): number;
      closeStorage(): void;
    },
  ) {
    if (options.access.owner !== options.owner) throw Error('协作访问能力不属于原账号');
    this.key = JSON.stringify([
      'collaboration-view',
      options.origin,
      options.owner,
      options.workspace,
      options.replica,
      options.session,
    ]);
  }
  alive = () => {
    if (this.closed) throw Error('协作页面已关闭，请重新打开');
  };
  current = () => {
    this.alive();
    if (
      !this.actor ||
      this.actor.accountId !== this.options.owner ||
      (this.saved && actorKey(this.saved.actor) !== actorKey(this.actor))
    )
      throw Error('协作账号已变化，请重新登录');
  };
  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.actor = undefined;
    this.options.closeStorage();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  };
  onClose(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    this.current();
    try {
      const identity = await this.options.access.identity();
      this.alive();
      if (
        !identity.actor ||
        identity.owner !== this.options.owner ||
        actorKey(identity.actor) !== actorKey(this.actor!)
      ) {
        this.close();
        throw Error('协作账号已变化，请重新登录');
      }
      const result = await work();
      this.current();
      return result;
    } catch (error) {
      if (error instanceof RequestFailure && [401, 403].includes(error.status ?? 0)) this.close();
      throw error;
    }
  }
  async open(identity: Promise<{ owner: string | null; actor?: AttentionActor } | null>) {
    const raw = await this.options.storage.read(this.key);
    this.alive();
    this.saved = raw == null ? undefined : descriptorSchema.parse(raw);
    const me = await identity;
    this.alive();
    if (me !== null && (me.owner !== this.options.owner || !me.actor)) {
      this.close();
      throw Error('协作账号已退出或改变，请重新登录');
    }
    this.actor = me?.actor ? actorSchema.parse(me.actor) : this.saved?.actor;
    try {
      await this.read();
    } catch (error) {
      this.alive();
      if (
        !this.saved ||
        !this.actor ||
        (error instanceof RequestFailure && [401, 403].includes(error.status ?? 0))
      ) {
        this.close();
        throw error;
      }
    }
    this.current();
    if (!this.saved) {
      this.close();
      throw Error('此设备还没有共享会话缓存，请先在线打开一次');
    }
    const client = new CollaborationClient({
      scope: this.saved.read.scope,
      author: { actor: this.saved.actor, clientId: this.saved.clientId },
      storage: this.options.storage,
      current: this.current,
      uuid: this.options.uuid,
      now: this.options.now,
      transport: {
        sync: (value) => this.guarded(() => this.options.access.sync(value)),
        offer: (value) => this.guarded(() => this.options.access.offer!(value)),
      },
    });
    await client.state.recover();
    this.current();
    return {
      client,
      initial: this.saved.read,
      actor: this.saved.actor,
      draftKey: JSON.stringify([
        'moor-collaboration-composer',
        this.options.origin,
        this.saved.actor,
        this.saved.read.scope,
        'shared-draft',
      ]),
    };
  }
  read = async (): Promise<CollaborationRead> => {
    this.alive();
    let identity: Awaited<ReturnType<CollaborationPageAccess['identity']>>;
    try {
      identity = await this.options.access.identity();
    } catch (error) {
      if (error instanceof RequestFailure && [401, 403].includes(error.status ?? 0)) this.close();
      throw error;
    }
    this.alive();
    if (
      !identity.actor ||
      identity.owner !== this.options.owner ||
      (this.actor && actorKey(identity.actor) !== actorKey(this.actor))
    ) {
      this.close();
      throw Error('协作账号已变化，请重新登录');
    }
    this.actor = actorSchema.parse(identity.actor);
    const read = collaborationReadResponseSchema.parse(
      await this.guarded(() => this.options.access.read()),
    );
    if (
      read.scope.workspaceId !== this.options.workspace ||
      read.scope.sessionId !== this.options.session ||
      read.target.sessionId !== this.options.session ||
      read.scope.authorityId !== this.actor?.authorityId
    ) {
      this.close();
      throw Error('共享会话响应不属于原页面范围');
    }
    this.current();
    readClientSession(read.session, read.target);
    await this.options.storage.exclusive(this.key, this.current, async () => {
      const previous = await this.options.storage.read(this.key);
      this.current();
      const existing = previous == null ? undefined : descriptorSchema.parse(previous);
      if (
        existing &&
        (actorKey(existing.actor) !== actorKey(this.actor!) ||
          JSON.stringify(existing.read.scope) !== JSON.stringify(read.scope) ||
          JSON.stringify(existing.read.target) !== JSON.stringify(read.target))
      ) {
        this.close();
        throw Error('共享会话的执行绑定已变化，原待同步任务仍保留在本机');
      }
      const next = {
        actor: this.actor!,
        read,
        clientId: existing?.clientId ?? this.options.uuid(),
      };
      await this.options.storage.compareAndSet(this.key, previous ?? null, next, this.current);
      this.current();
      this.saved = next;
    });
    this.current();
    return read;
  };
  private action(work: () => Promise<unknown>) {
    return this.guarded(work);
  }
  enable = () => this.action(() => this.options.access.enable());
  member = (accountId: string, role: 'viewer' | 'operator' | null) =>
    this.action(() => this.options.access.member(accountId, role));
  invite = async () => {
    const link = await this.action(() => this.options.access.invite());
    return String(link);
  };
}
