import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import { LocalLoroTransportAdapter } from '@lody/shared/local-loro-transport';
import type { LocalControlClientService } from '@lody/shared/node/local-ipc';
import { Flock, LoroDoc, VersionVector, decode, delta, metas, mirror } from '../model';
import { assert, AppError, type RuntimeWorkspace, type Mutation } from '../protocol';
import { validateMutation } from './validate-mutation';
import { Journal } from './journal';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
type DocState = { doc: LoroDoc; sub: any; off: () => void; watched: boolean; users: number };
export class HostWorkspace {
  meta = new Flock();
  machine = new Flock();
  adapter: LocalLoroTransportAdapter;
  metaSub: any;
  machineSub: any;
  docs = new Map<string, DocState>();
  serverVersions = new Map<string, string>();
  peerId = crypto.randomUUID();
  locks = new Map<string, Promise<unknown>>();
  disposeMessage: () => void;
  disposeStatus: () => void;
  closed = false;
  lifetime = new AbortController();
  constructor(
    public workspace: RuntimeWorkspace,
    private link: LocalLoroDataPlaneConnection,
    private control: LocalControlClientService,
    private journal: Journal,
    private catalogue: () => void,
    private changed: (sessionId?: string) => void,
  ) {
    this.adapter = new LocalLoroTransportAdapter({
      workspaceId: workspace.id,
      peerId: this.peerId,
      connection: link,
    });
    this.disposeMessage = link.onMessage((m) => {
      if (
        m.type === 'joined' &&
        m.peerId === this.peerId &&
        m.workspaceId === workspace.id &&
        m.room.scope === 'doc' &&
        m.serverVersion
      )
        this.serverVersions.set(m.room.docId, m.serverVersion);
    });
    this.disposeStatus = link.onStatusChange((connected) => {
      if (!connected) this.close();
    });
    this.metaSub = this.adapter.joinMetaRoom(this.meta);
    this.machineSub = this.adapter.joinFlockDocRoom(
      `${workspace.id}:mf:${workspace.machineId}`,
      this.machine,
    );
    this.meta.subscribe(() => this.changed());
    this.machine.subscribe(() => this.updateCatalogue());
  }
  ensureConnected() {
    assert(!this.closed && this.link.isConnected(), 409, '本地 Lody 已断开，指令未送达');
  }
  async connected<T>(work: Promise<T>): Promise<T> {
    this.ensureConnected();
    const signal = this.lifetime.signal;
    let abort: () => void = () => {};
    const timeout = setTimeout(() => this.close(), 15000);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          abort = () => reject(new AppError(504, '本地连接已中断，送达结果待确认'));
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
  async ready() {
    await this.connected(
      Promise.all([this.metaSub.firstSyncedWithRemote, this.machineSub.firstSyncedWithRemote]),
    );
    this.ensureConnected();
    this.updateCatalogue();
  }
  updateCatalogue() {
    this.workspace.projects = this.machine
      .scan({ prefix: ['localProject'] })
      .map((r) => r.value as any)
      .filter((v) => v?.id && v.rootPath)
      .map((v) => ({ id: v.id, name: v.name, rootPath: v.rootPath }));
    this.workspace.agents = this.machine
      .scan({ prefix: ['agentConfig'] })
      .map((r) => r.value as any)
      .filter((v) => v?.id && v.machineId === this.workspace.machineId)
      .map((v) => ({ id: v.id, name: v.name, cliType: v.cliType, agentType: v.agentType }));
    this.catalogue();
  }
  async acquire(sessionId: string) {
    this.ensureConnected();
    assert(/^[A-Za-z0-9_-]{1,160}$/.test(sessionId), 400, '会话编号无效');
    const name = 'session-' + sessionId;
    let state = this.docs.get(name);
    if (!state) {
      assert(this.docs.size < 32, 429, '打开的会话过多');
      const doc = new LoroDoc(),
        sub = this.adapter.joinDocRoom(name, doc);
      state = {
        doc,
        sub,
        watched: false,
        users: 0,
        off: doc.subscribe(() => {
          if (this.docs.get(name)?.watched) this.changed(sessionId);
        }),
      };
      this.docs.set(name, state);
    }
    state.users++;
    try {
      await this.connected(state.sub.firstSyncedWithRemote);
      this.ensureConnected();
      assert(state.sub.status === 'joined', 502, '本地文档尚未同步');
      return state;
    } catch (e) {
      this.release(sessionId);
      throw e;
    }
  }
  release(sessionId: string) {
    const name = 'session-' + sessionId,
      s = this.docs.get(name);
    if (!s) return;
    s.users--;
    this.evict(name, s);
  }
  evict(name: string, s: DocState) {
    if (s.users <= 0 && !s.watched) {
      s.off();
      s.sub.unsubscribe();
      this.docs.delete(name);
      this.serverVersions.delete(name);
    }
  }
  async watch(sessionId: string, on: boolean) {
    const name = 'session-' + sessionId;
    if (on) {
      if (metas(this.meta)[name]?.machineId !== this.workspace.machineId) return;
      const s = await this.acquire(sessionId);
      s.watched = true;
      this.release(sessionId);
    } else {
      const s = this.docs.get(name);
      if (s) {
        s.watched = false;
        this.evict(name, s);
      }
    }
  }
  list(localProjectId?: string) {
    this.ensureConnected();
    return Object.entries(metas(this.meta))
      .filter(
        ([name, m]) =>
          name.startsWith('session-') &&
          m.id &&
          m.machineId === this.workspace.machineId &&
          (!localProjectId || (m.project as any)?.localProjectId === localProjectId),
      )
      .map(([, m]) => m)
      .sort((a: any, b: any) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }
  checkProject(sessionId: string, localProjectId?: string) {
    if (!localProjectId) return;
    const meta = metas(this.meta)['session-' + sessionId];
    assert((meta?.project as any)?.localProjectId === localProjectId, 404, '会话不属于该项目副本');
  }
  async read(sessionId: string, version?: string, localProjectId?: string) {
    this.checkProject(sessionId, localProjectId);
    const meta = metas(this.meta)['session-' + sessionId];
    assert(meta?.machineId === this.workspace.machineId, 404, '会话不属于这台电脑');
    const s = await this.acquire(sessionId);
    try {
      return {
        meta,
        metaBundle: this.meta.exportJson(),
        update: delta(s.doc, version),
        synced: true,
        online: true,
      };
    } finally {
      this.release(sessionId);
    }
  }
  async confirm(sessionId: string, s: DocState, expected: VersionVector) {
    // The first reconciliation uploads imported browser ops. A second ordered join
    // confirms the daemon received those exact CRDT operations before delivery is acknowledged.
    for (let i = 0; i < 2; i++) {
      this.ensureConnected();
      await this.connected(s.sub.rejoin());
      await this.connected(s.sub.waitUntilSynced());
      this.ensureConnected();
      const encoded = this.serverVersions.get('session-' + sessionId);
      if (encoded && (VersionVector.decode(decode(encoded)).compare(expected) ?? -1) >= 0) return;
    }
    throw new AppError(504, '执行主机未确认文档接收，请重试确认');
  }
  async mutate(m: Mutation, localProjectId?: string) {
    return this.serial(m.sessionId, async () => {
      if (metas(this.meta)['session-' + m.sessionId])
        this.checkProject(m.sessionId, localProjectId);
      const record = this.journal.lookup(this.workspace.id, m);
      if (record && localProjectId) this.checkProject(m.sessionId, localProjectId);
      if (record?.phase === 'accepted') return JSON.parse(record.result);
      this.ensureConnected();
      const s = await this.acquire(m.sessionId);
      let staged = Boolean(record);
      try {
        if (record) {
          const state = mirror(s.doc, m.sessionId),
            history = state.getState().history,
            meta = metas(this.meta)['session-' + m.sessionId];
          const accepted =
            m.kind === 'turn'
              ? history.some(
                  (t) =>
                    t.id === record.turn_id &&
                    (t.read || t.status === 'processing' || t.status === 'handled'),
                ) || meta?.lastHandledUserMsgId === record.turn_id
              : history.some((t) => {
                  const expected = record.approval ? JSON.parse(record.approval) : null;
                  return (
                    expected &&
                    t.id === expected.turnId &&
                    (t.items ?? []).some(
                      (i: any) =>
                        i.permissionRequest?.requestId === m.requestId &&
                        isDeepStrictEqual(i.permissionRequest.outcome, expected.outcome),
                    )
                  );
                });
          state.dispose();
          if (accepted) return this.journal.accept(m);
          if (
            m.kind === 'permission' &&
            history.some(
              (t) =>
                (t.finished &&
                  (t.items ?? []).some(
                    (i: any) => i.permissionRequest?.requestId === m.requestId,
                  )) ||
                (t.items ?? []).some(
                  (i: any) =>
                    i.permissionRequest?.requestId === m.requestId && i.permissionRequest.outcome,
                ),
            )
          )
            throw new AppError(409, '审批已被另一端处理，不可覆盖', true);
        }
        const current = metas(this.meta)['session-' + m.sessionId];
        if (record)
          assert(
            !current?.latestUserMsgId ||
              current.latestUserMsgId === m.expectedTurnId ||
              current.latestUserMsgId === record.turn_id,
            409,
            '会话已有新回合，旧指令不能再次派发',
          );
        const validated = record ? null : validateMutation(s.doc, this.meta, this.workspace, m);
        if (localProjectId && validated)
          assert(
            (metas(validated.flock)['session-' + m.sessionId].project as any)?.localProjectId ===
              localProjectId,
            400,
            '执行项目与副本不匹配',
          );
        const turnId =
          record?.turn_id ??
          String(metas(validated!.flock)['session-' + m.sessionId].latestUserMsgId ?? '');
        let approval: unknown;
        if (validated && m.kind === 'permission') {
          const v = mirror(validated.doc, m.sessionId);
          for (const t of v.getState().history)
            for (const raw of t.items ?? []) {
              const i = raw as {
                type?: string;
                permissionRequest?: { requestId: string; outcome: unknown };
              };
              if (
                i.type === 'tool_call' &&
                i.permissionRequest &&
                i.permissionRequest.requestId === m.requestId
              )
                approval = { turnId: t.id, outcome: i.permissionRequest.outcome };
            }
          v.dispose();
        }
        this.ensureConnected();
        this.journal.stage(this.workspace.id, m, turnId, approval);
        staged = true;
        s.doc.import(decode(m.update));
        s.doc.commit();
        await this.confirm(m.sessionId, s, s.doc.version());
        if (m.metaBundle) {
          this.ensureConnected();
          this.meta.importJson(m.metaBundle as never);
          this.meta.commit();
          for (let i = 0; i < 2; i++) {
            this.ensureConnected();
            await this.connected(this.metaSub.rejoin());
            await this.connected(this.metaSub.waitUntilSynced());
          }
          this.ensureConnected();
        }
        if (m.kind === 'turn') {
          const view = mirror(s.doc, m.sessionId),
            turn = view.getState().history.find((t) => t.id === turnId)!;
          view.dispose();
          this.ensureConnected();
          const response = await Effect.runPromise(
            this.control.machineRpc(
              {
                method: 'session/dispatch-turn',
                workspaceId: this.workspace.id,
                machineId: this.workspace.machineId,
                params: {
                  sessionId: m.sessionId as never,
                  userTurnId: turnId,
                  userId: this.workspace.userId,
                  timestamp: turn.timestamp,
                  inputConfig: turn.inputConfig as never,
                },
              },
              { timeoutMs: 10000 },
            ),
          );
          assert(
            response.ok && 'accepted' in response.result && response.result.accepted,
            504,
            'Lody 尚未确认接收该指令，请重试确认',
          );
        }
        const result = this.journal.accept(m);
        this.changed(m.sessionId);
        return result;
      } catch (e) {
        if (e instanceof AppError && e.rejected) throw e;
        if (staged) throw new AppError(504, '执行结果待确认，请重试同一请求；不会重复创建回合');
        throw e;
      } finally {
        this.release(m.sessionId);
      }
    });
  }
  async cancel(sessionId: string, turnId: string, localProjectId?: string) {
    return this.serial(sessionId, async () => {
      this.checkProject(sessionId, localProjectId);
      this.ensureConnected();
      assert(
        metas(this.meta)['session-' + sessionId]?.machineId === this.workspace.machineId,
        404,
        '会话不属于这台电脑',
      );
      const s = await this.acquire(sessionId);
      try {
        const view = mirror(s.doc, sessionId),
          active = view
            .getState()
            .history.some((t) => t.id === turnId && t.role === 'assistant' && !t.finished);
        view.dispose();
        assert(active, 409, '该回合已经结束');
        this.ensureConnected();
        const result = await Effect.runPromise(
          this.control.sessionControl(
            {
              type: 'session/cancel',
              machineId: this.workspace.machineId as never,
              workspaceId: this.workspace.id as never,
              sessionId: sessionId as never,
              turnId,
            },
            { timeoutMs: 10000 },
          ),
        );
        return (
          result.find((r) => r.type === 'session/cancel_response') ?? {
            success: false,
            error: '未获确认',
          }
        );
      } finally {
        this.release(sessionId);
      }
    });
  }
  async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.disposeStatus();
    this.disposeMessage();
    for (const s of this.docs.values()) {
      s.off();
      s.sub.unsubscribe();
    }
    this.docs.clear();
    this.metaSub.unsubscribe();
    this.machineSub.unsubscribe();
    void this.adapter.close();
  }
}
