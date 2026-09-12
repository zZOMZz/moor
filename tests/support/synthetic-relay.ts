import { syntheticCapabilities } from './agent-capabilities';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from '../../src/relay/accounts';
import { createApp } from '../../src/relay/http';
import { PROTOCOL, sessionActionSchema, type RuntimeWorkspace } from '../../src/protocol';
import { Flock, LoroDoc, decode, delta, metas, mirror, putMeta } from '../../src/model';
import {
  CONTENT_VERSION,
  FILE_CONTENT_FEATURE,
  projectFileReadSchema,
  type ProjectFileResult,
} from '../../src/content-protocol';

// In-memory integration fixture: never starts a runtime, reads a project, or contacts a model.
// The real IPC delivery and mutation checks are exercised separately in host.test.ts.
export async function syntheticRelay(port = 0) {
  const store = new Store(':memory:');
  const secret = await store.setup('synthetic@example.com', 'synthetic-password-only');
  const owner = store.owner(secret);
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic',
    publicDir: 'dist/public',
  });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin);
  const hosts = [];
  for (const label of ['A', 'B']) {
    const device = store.redeem(store.pair(owner), 'Synthetic Mac ' + label);
    const runtime: RuntimeWorkspace = {
      id: 'lw-synthetic',
      name: 'Moor host',
      machineId: 'machine-' + label,
      userId: 'synthetic-' + label,
      projects: [
        { id: 'local-moor', name: 'moor', rootPath: `/synthetic/${label}/moor` },
        { id: 'local-other', name: 'other', rootPath: `/synthetic/${label}/other` },
      ],
      agents: [
        {
          id: 'agent',
          name: 'Synthetic Codex',
          cliType: 'builtin',
          agentType: 'codex',
          runConfig: syntheticCapabilities,
        },
      ],
      features: ['session-actions', FILE_CONTENT_FEATURE],
    };
    const meta = new Flock(),
      docs = new Map<string, LoroDoc>(),
      operations = new Set<string>(),
      sessionActions = new Map<string, { input: string; result: unknown }>();
    const fileContents = new Map([
      ['README.md', Buffer.from(`Synthetic file from host ${label}\n`)],
    ]);
    const fileResponse: {
      transform?: (result: ProjectFileResult) => unknown;
      beforeSend?: () => Promise<void>;
    } = {};
    const sessionId = 'same-session-id';
    const doc = new LoroDoc(),
      view = mirror(doc, sessionId);
    view.setState(
      (s: any) =>
        void s.history.push({
          id: 'seed-turn',
          role: 'user',
          userId: runtime.userId,
          timestamp: '2026-01-01T00:00:00Z',
          finished: true,
          items: [{ type: 'text', text: `来自主机 ${label} 的合成会话` }],
          fileDiff: null,
        }),
    );
    view.dispose();
    doc.commit();
    docs.set(sessionId, doc);
    putMeta(meta, 'session-' + sessionId, {
      id: sessionId,
      title: `合成会话 ${label}`,
      machineId: runtime.machineId,
      userId: runtime.userId,
      project: { kind: 'local', localProjectId: 'local-moor' },
      cliType: 'builtin',
      agentType: 'codex',
      agentConfigId: 'agent',
      lastMessageAt: label === 'A' ? 1 : 2,
    });
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
      headers: { Authorization: 'Bearer ' + device.token },
    });
    const messages: any[] = [];
    const ready = new Promise<void>((resolve) =>
      socket.on('message', async (raw) => {
        const m = JSON.parse(raw.toString());
        messages.push(m);
        if (m.type === 'ready') resolve();
        if (m.type !== 'request') return;
        let result: unknown, error: unknown;
        const current = metas(meta)['session-' + m.params.sessionId];
        if (m.method === 'sessions')
          result = Object.values(metas(meta)).filter(
            (s) => !m.localProjectId || (s.project as any).localProjectId === m.localProjectId,
          );
        else if (m.method === 'agent-options')
          result = runtime.agents.find((a) => a.id === m.params.agentId);
        else if (m.method === 'session') {
          if (
            !current ||
            (m.localProjectId && (current.project as any).localProjectId !== m.localProjectId)
          )
            error = { status: 404, message: '会话不属于该项目副本' };
          else
            result = {
              meta: current,
              metaBundle: meta.exportJson(),
              update: delta(docs.get(m.params.sessionId)!, m.params.version),
              synced: true,
              online: true,
            };
        } else if (m.method === 'mutate') {
          if (!operations.has(m.params.operationId)) {
            const candidate = docs.get(m.params.sessionId) ?? new LoroDoc();
            candidate.import(decode(m.params.update));
            candidate.commit();
            docs.set(m.params.sessionId, candidate);
            if (m.params.metaBundle) meta.importJson(m.params.metaBundle);
            operations.add(m.params.operationId);
          }
          result = { accepted: true, delivered: true, operationId: m.params.operationId };
        } else if (m.method === 'session-action') {
          const parsed = sessionActionSchema.safeParse(m.params);
          if (!parsed.success) error = { status: 400, message: '请求格式无效', rejected: true };
          else {
            const action = parsed.data,
              receipt = sessionActions.get(action.operationId);
            if (
              action.workspaceId !== runtime.id ||
              !current ||
              (current.project as any).localProjectId !== action.localProjectId ||
              m.localProjectId !== action.localProjectId
            )
              error = { status: 404, message: '会话不属于该项目副本', rejected: true };
            else if (receipt) {
              if (receipt.input !== JSON.stringify(action))
                error = { status: 409, message: '重复编号对应不同请求', rejected: true };
              else result = receipt.result;
            } else if ((current.metadataRevision ?? 0) !== action.expectedRevision)
              error = { status: 409, message: '会话信息已更新，请刷新后重试', rejected: true };
            else {
              putMeta(meta, 'session-' + action.sessionId, {
                metadataRevision: action.expectedRevision + 1,
                isArchived: current.isArchived === true,
                isPinned: current.isPinned === true,
                ...(action.action === 'rename' ? { title: action.title, titleSource: 'user' } : {}),
                ...(['archive', 'restore'].includes(action.action)
                  ? { isArchived: action.action === 'archive' }
                  : {}),
                ...(['pin', 'unpin'].includes(action.action)
                  ? { isPinned: action.action === 'pin' }
                  : {}),
              });
              result = {
                accepted: true,
                delivered: true,
                operationId: action.operationId,
                meta: metas(meta)['session-' + action.sessionId],
              };
              sessionActions.set(action.operationId, { input: JSON.stringify(action), result });
            }
          }
        } else if (m.method === 'file-content') {
          const parsed = projectFileReadSchema.safeParse(m.params);
          if (!parsed.success) error = { status: 400, message: '请求格式无效' };
          else {
            const input = parsed.data;
            const bytes = fileContents.get(input.path);
            if (
              input.workspaceId !== runtime.id ||
              !current ||
              (current.project as any).localProjectId !== input.localProjectId ||
              m.localProjectId !== input.localProjectId
            )
              error = { status: 404, message: '会话不属于该项目副本' };
            else if (!bytes) error = { status: 404, message: '文件不可用' };
            else {
              const version = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
              const response: ProjectFileResult = {
                contentVersion: CONTENT_VERSION,
                workspaceId: runtime.id,
                localProjectId: input.localProjectId,
                sessionId: input.sessionId,
                path: input.path,
                confirmed: true,
                content: { version, byteLength: bytes.byteLength, mediaType: 'text/plain' },
                ...(input.knownVersion === version
                  ? { status: 'not-modified' }
                  : { status: 'content', encoding: 'base64', data: bytes.toString('base64') }),
              };
              result = fileResponse.transform ? fileResponse.transform(response) : response;
            }
          }
        } else if (m.method === 'cancel') result = { success: true };
        if (m.method === 'file-content') await fileResponse.beforeSend?.();
        socket.send(JSON.stringify({ type: 'response', requestId: m.requestId, result, error }));
        if (m.method === 'mutate' || (m.method === 'session-action' && !error))
          socket.send(
            JSON.stringify({
              type: 'changed',
              workspaceId: runtime.id,
              sessionId: m.params.sessionId,
            }),
          );
      }),
    );
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: runtime.machineId,
        workspaces: [runtime],
      }),
    );
    await ready;
    hosts.push({
      device,
      runtime,
      socket,
      messages,
      operations,
      sessionActions,
      fileContents,
      fileResponse,
    });
  }
  const api = async (path: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'personal=' + secret, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    app,
    store,
    owner,
    origin,
    secret,
    hosts,
    api,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
