import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { HostWorkspace } from './host-workspace';
import { acquireRuntimeLock } from '../runtime/lock';
import { RuntimeStore } from '../runtime/store';
import { acpDriver } from '../runtime/acp';
import { localCodexPath, withLocalCodex } from './local-codex';
import { Store, token } from '../relay/accounts';
import { createApp } from '../relay/http';
import { AppError, assert, mutationSchema, sessionActionSchema, PROTOCOL } from '../protocol';
import { projectFileReadSchema } from '../content-protocol';
import { attachmentActionSchema, attachmentReadSchema } from '../attachment-protocol';
import {
  projectTreeReadSchema,
  projectTurnDiffReadSchema,
  projectDiffFileReadSchema,
} from '../project-content-protocol';
import { questionAnswerSchema, steerRequestSchema } from '../interaction-protocol';
import { sessionSearchRequestSchema } from '../search-protocol';
const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    pair: { type: 'string' },
    name: { type: 'string' },
    config: { type: 'string' },
    'runtime-data': { type: 'string' },
    project: { type: 'string', multiple: true },
    'builtin-agent': { type: 'string', multiple: true },
    desktop: { type: 'boolean' },
    'public-dir': { type: 'string' },
  },
});
type Config = { server: string; id: string; token: string };
const configPath = resolve(values.config ?? '.data/bridge-v3.json');
let config: Config | undefined;
if (values.pair) {
  if (!values.server) throw new Error('配对时需要 --server');
  const url = new URL(values.server);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程连接需要 HTTPS');
  const r = await fetch(new URL('/api/pair/redeem', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + values.pair },
    body: JSON.stringify({ code: values.pair, name: values.name ?? hostname() }),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await r.json()) as any;
  if (!r.ok) throw new Error(result.error ?? '配对失败');
  config = { server: url.origin, ...result };
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config) + '\n', { mode: 0o600 });
  console.log('设备已配对');
} else {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (!values.desktop) throw e;
  }
}
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
const runtimeFile = resolve(
  values['runtime-data'] ??
    process.env.MOOR_RUNTIME_DATA ??
    join(dirname(configPath), 'runtime-v1.sqlite'),
);
let releaseRuntime: () => void;
try {
  releaseRuntime = acquireRuntimeLock(runtimeFile + '.ownership.sqlite');
} catch {
  console.error('已有 Moor 实例使用该数据目录，或主机锁需要检查');
  process.exit(3);
}
process.once('exit', releaseRuntime);
const runtime = new RuntimeStore(runtimeFile);
const workspaces = new Map<string, HostWorkspace>(),
  journal = runtime.journal;
type Target = {
  config: Config;
  local: boolean;
  socket?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  watches: Map<string, { workspaceId: string; sessionId: string }>;
  revoked: boolean;
};
const targets: Target[] = [];
let stopped = false,
  machineId = runtime.workspace.machineId,
  ready = false,
  refreshing = false,
  projectsRegistered = false;
const send = (ws: WebSocket | undefined, v: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(v));
};
function reportHealth() {
  if (!process.send || !process.connected) return;
  const remote = targets.find((t) => !t.local);
  process.send({
    type: 'health',
    local: ready && workspaces.size > 0 ? 'ready' : 'unavailable',
    relay: !remote
      ? 'unpaired'
      : remote.revoked
        ? 'revoked'
        : remote.socket?.readyState === WebSocket.OPEN
          ? 'connected'
          : 'reconnecting',
    workspaces: [...workspaces.values()].filter((w) => !w.closed).length,
  });
}
function broadcast(v: unknown) {
  for (const t of targets) send(t.socket, v);
}
function hello() {
  if (ready)
    broadcast({
      type: 'hello',
      protocol: PROTOCOL,
      machineId,
      workspaces: [...workspaces.values()].filter((w) => !w.closed).map((w) => w.workspace),
    });
}
async function syncWatch(workspaceId: string, sessionId: string) {
  const wanted = targets.some((t) => t.watches.has(workspaceId + '/' + sessionId));
  await workspaces.get(workspaceId)?.watch(sessionId, wanted);
}
async function refresh() {
  if (stopped || refreshing) return;
  refreshing = true;
  try {
    let host = workspaces.get(runtime.workspace.id);
    if (!host) {
      host = new HostWorkspace(runtime, acpDriver, hello, (sessionId) =>
        broadcast({ type: 'changed', workspaceId: runtime.workspace.id, sessionId }),
      );
      workspaces.set(runtime.workspace.id, host);
    }
    if (!projectsRegistered) {
      for (const project of values.project ?? []) runtime.registerProject(resolve(project));
      for (const agentType of values['builtin-agent'] ?? []) {
        assert(['codex', 'claude'].includes(agentType), 400, '仅支持 Codex 或 Claude');
        const id = 'personal-' + agentType;
        const existing = runtime.machine.get(['agentConfig', id]);
        const base = existing ?? {
          id,
          name: agentType === 'codex' ? 'Codex' : 'Claude',
          machineId,
          cliType: 'builtin',
          agentType,
        };
        runtime.machine.set(
          ['agentConfig', id],
          withLocalCodex(base, agentType === 'codex' ? localCodexPath() : undefined),
        );
      }
      runtime.saveMachine();
      projectsRegistered = true;
    }
    host.updateCatalogue();
    ready = true;
    hello();
  } catch {
    ready = false;
    broadcast({ type: 'unavailable' });
  } finally {
    refreshing = false;
    reportHealth();
  }
}
function connect(target: Target) {
  if (stopped || target.revoked) return;
  const url = new URL('/bridge', target.config.server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + target.config.token } });
  target.socket = ws;
  ws.on('open', () => {
    console.log('中转连接已建立');
    reportHealth();
    void refresh();
  });
  ws.on('error', () => {});
  ws.on('unexpected-response', (request, response) => {
    if ([401, 403].includes(response.statusCode ?? 0)) target.revoked = true;
    response.resume();
    request.destroy();
    ws.terminate();
    reportHealth();
  });
  ws.on('message', async (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'watch' || m.type === 'unwatch') {
        if (m.type === 'watch' && m.localProjectId)
          workspaces.get(m.workspaceId)?.checkProject(m.sessionId, m.localProjectId);
        const key = m.workspaceId + '/' + m.sessionId;
        if (m.type === 'watch')
          target.watches.set(key, { workspaceId: m.workspaceId, sessionId: m.sessionId });
        else target.watches.delete(key);
        await syncWatch(m.workspaceId, m.sessionId);
      }
      if (m.type === 'request') {
        try {
          const workspace = workspaces.get(m.workspaceId);
          assert(ready && workspace && !workspace.closed, 409, '本机执行服务不可达');
          let result: unknown;
          if (m.method === 'sessions') result = workspace.list(m.localProjectId);
          else if (m.method === 'agent-options')
            result = await workspace.refreshAgentOptions(m.params.agentId, m.localProjectId);
          else if (m.method === 'session')
            result = await workspace.read(m.params.sessionId, m.params.version, m.localProjectId);
          else if (m.method === 'mutate') {
            const body = mutationSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.mutate(body, m.localProjectId);
          } else if (m.method === 'session-action') {
            const body = sessionActionSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.sessionAction(body, m.localProjectId);
          } else if (m.method === 'file-content') {
            const body = projectFileReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readProjectFile(body, m.localProjectId);
          } else if (m.method === 'attachment-action') {
            const body = attachmentActionSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.attachmentAction(body, m.localProjectId);
          } else if (m.method === 'read-attachment') {
            const body = attachmentReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readAttachment(body, m.localProjectId);
          } else if (m.method === 'read-project-tree') {
            const body = projectTreeReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readProjectTree(body, m.localProjectId);
          } else if (m.method === 'read-turn-diff') {
            const body = projectTurnDiffReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readTurnDiff(body, m.localProjectId);
          } else if (m.method === 'read-diff-file') {
            const body = projectDiffFileReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readDiffFile(body, m.localProjectId);
          } else if (m.method === 'answer-question') {
            const body = questionAnswerSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.answerQuestion(body, m.localProjectId);
          } else if (m.method === 'steer') {
            const body = steerRequestSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.steer(body, m.localProjectId);
          } else if (m.method === 'search-sessions') {
            const body = sessionSearchRequestSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.searchSessions(body, m.localProjectId);
          } else if (m.method === 'cancel')
            result = await workspace.cancel(m.params.sessionId, m.params.turnId, m.localProjectId);
          else throw new AppError(400, '不支持的操作');
          send(ws, { type: 'response', requestId: m.requestId, result });
        } catch (e) {
          send(ws, {
            type: 'response',
            requestId: m.requestId,
            error: {
              status: e instanceof AppError ? e.status : 502,
              message: e instanceof AppError ? e.message : '本地主机处理失败',
              rejected:
                (e instanceof AppError && e.rejected) ||
                (['mutate', 'session-action', 'attachment-action'].includes(m.method) &&
                  typeof m.params?.operationId === 'string' &&
                  !journal.has(m.params.operationId)),
            },
          });
        }
      }
    } catch (e) {
      console.error('请求处理失败：', e instanceof Error ? e.message : '未知错误');
    }
  });
  ws.on('close', (code) => {
    const watches = [...target.watches.values()];
    target.watches.clear();
    for (const w of watches) void syncWatch(w.workspaceId, w.sessionId).catch(() => {});
    if (code === 1008) {
      target.revoked = true;
      console.error('设备授权已失效或连接已替换，请重新配对');
      reportHealth();
      return;
    }
    reportHealth();
    if (!stopped && !target.revoked) target.retry = setTimeout(() => connect(target), 2000);
  });
}
let localApp: ReturnType<typeof createApp> | undefined, localStore: Store | undefined;
if (values.desktop) {
  // A loopback-only relay keeps the same UI usable without a public server.
  // Persist product organization across restarts; session data belongs to the Moor execution host.
  // Native main receives its credential over the private child-process IPC channel.
  assert(Boolean(process.send), 500, '本机界面必须由客户端启动');
  localStore = new Store(configPath + '.catalog.sqlite');
  chmodSync(configPath + '.catalog.sqlite', 0o600);
  localStore.db.prepare('DELETE FROM login').run();
  const secret = localStore.hasAccount()
    ? localStore.createLogin('local-desktop')
    : await localStore.setup('local@localhost.invalid', token(), 'local-desktop');
  const owner = localStore.owner(secret),
    device = localStore.localDevice(owner, values.name ?? hostname());
  localApp = createApp(localStore, {
    origin: 'http://127.0.0.1:0',
    setupToken: token(),
    publicDir: values['public-dir'],
    localOnly: true,
  });
  let localPort = 0;
  try {
    localPort = Number(readFileSync(configPath + '.local-port', 'utf8'));
  } catch {}
  await new Promise<void>((resolve, reject) => {
    localApp!.server.once('error', reject);
    localApp!.server.listen(localPort, '127.0.0.1', resolve);
  });
  const address = localApp.server.address();
  assert(address && typeof address === 'object', 500, '无法启动本机界面');
  writeFileSync(configPath + '.local-port', String(address.port), { mode: 0o600 });
  const origin = 'http://127.0.0.1:' + address.port;
  localApp.setOrigin(origin);
  targets.push({
    config: { server: origin, ...device },
    local: true,
    watches: new Map(),
    revoked: false,
  });
  process.send!({ type: 'local-ready', origin, secret });
}
if (
  config &&
  (values.server === undefined ||
    (values.server && config.server === new URL(values.server).origin))
)
  targets.push({ config, local: false, watches: new Map(), revoked: false });
reportHealth();
const refreshTimer = setInterval(() => void refresh(), 10000);
for (const target of targets) connect(target);
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(refreshTimer);
  for (const target of targets) {
    clearTimeout(target.retry);
    target.socket?.terminate();
  }
  for (const w of workspaces.values()) w.close();
  await localApp?.close();
  localStore?.close();
  runtime.close();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
