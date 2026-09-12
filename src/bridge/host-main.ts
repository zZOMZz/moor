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
import { NotificationDispatcher, relayNotificationChannel } from './notification-dispatch';
import { gitStateReadSchema, gitActionSchema } from '../git-protocol';
import { forkOptionsReadSchema, sessionForkSchema } from '../fork-protocol';
import { githubReadSchema, githubActionSchema } from '../github-protocol';
import {
  githubWriteReadSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
} from '../github-write-protocol';
import { GitHubConfig } from '../runtime/github-config';
import { PreviewConfig, type PreviewLocalTarget } from '../runtime/preview-config';
import { createPreviewRenderer } from '../runtime/preview-renderer';
import { SkillsConfig } from '../runtime/skills-config';
import { skillsReadSchema } from '../skills-protocol';
import {
  previewReadSchema,
  previewActionSchema,
  previewInspectSchema,
  previewCloseSchema,
} from '../preview-protocol';
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
    'github-config-dir': { type: 'string' },
    'github-config-stdin': { type: 'boolean' },
    'preview-config-stdin': { type: 'boolean' },
    'skills-config-stdin': { type: 'boolean' },
  },
});
const configurationOnly =
  values['github-config-stdin'] || values['preview-config-stdin'] || values['skills-config-stdin'];
const configurationLabel = values['skills-config-stdin']
  ? 'Skills'
  : values['preview-config-stdin']
    ? '预览'
    : 'GitHub';
if (
  values['skills-config-stdin'] &&
  (values.desktop || values.pair || values['github-config-stdin'] || values['preview-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'Skills 本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
  );
  process.exit(1);
}
if (
  values['preview-config-stdin'] &&
  (values.desktop || values.pair || values['github-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: '预览本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
  );
  process.exit(1);
}
if (values['github-config-stdin'] && (values.desktop || values.pair)) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'GitHub 本机配置命令不能同时启动桌面或配对' }) + '\n',
  );
  process.exit(1);
}
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
    if (!values.desktop && !configurationOnly) throw e;
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
const githubConfig = new GitHubConfig(
  join(resolve(values['github-config-dir'] ?? dirname(runtimeFile)), 'github-v1.json'),
  {
    identity: () => ({
      workspaceId: runtime.workspace.id,
      machineId: runtime.workspace.machineId,
      userId: runtime.workspace.userId,
    }),
    projects: () =>
      runtime.machine
        .scan({ prefix: ['localProject'] })
        .map((row) => row.value as { id: string; name: string; rootPath: string }),
    changed: () => {
      if (!configurationOnly)
        broadcast({ type: 'github-changed', workspaceId: runtime.workspace.id });
    },
  },
);
const previewBlockedOrigins = new Set<string>();
if (config) previewBlockedOrigins.add(config.server);
const previewConfig = new PreviewConfig(join(dirname(runtimeFile), 'preview-v1.json'), {
  identity: () => ({
    workspaceId: runtime.workspace.id,
    machineId: runtime.workspace.machineId,
    userId: runtime.workspace.userId,
  }),
  targets: () => {
    const projects = runtime.machine
      .scan({ prefix: ['localProject'] })
      .map((row) => row.value as { id: string; name: string; rootPath: string });
    const targets: PreviewLocalTarget[] = projects.map((p) => ({
      localProjectId: p.id,
      executionId: 'shared',
      label: p.name + ' · 原目录',
      rootPath: p.rootPath,
      projectRoot: p.rootPath,
    }));
    for (const row of runtime.journal.db
      .prepare(
        'SELECT session_id,project_id FROM session_execution WHERE workspace_id=? AND user_id=? AND machine_id=?',
      )
      .all(runtime.workspace.id, runtime.workspace.userId, runtime.workspace.machineId)) {
      const project = projects.find((p) => p.id === row.project_id);
      if (!project) continue;
      try {
        const lease = runtime.executions.lease({
          workspaceId: runtime.workspace.id,
          userId: runtime.workspace.userId,
          machineId: runtime.workspace.machineId,
          localProjectId: project.id,
          sessionId: String(row.session_id),
          rootPath: project.rootPath,
        });
        targets.push({
          localProjectId: project.id,
          executionId: lease.executionId,
          label: project.name + ' · ' + lease.executionId,
          rootPath: lease.rootPath,
          projectRoot: lease.projectRoot,
        });
      } catch {
        /* Removed, changing or invalid worktrees cannot be registered. */
      }
    }
    return targets;
  },
  blockedOrigins: () => [...previewBlockedOrigins],
  changed: () => {
    if (!configurationOnly)
      for (const host of workspaces.values()) host.previewManager.invalidate();
  },
});
const skillsConfig = new SkillsConfig(join(dirname(runtimeFile), 'skills-v1.json'), {
  identity: () => ({
    workspaceId: runtime.workspace.id,
    machineId: runtime.workspace.machineId,
    userId: runtime.workspace.userId,
  }),
  projectRoots: () => {
    const projects = runtime.machine
      .scan({ prefix: ['localProject'] })
      .map((row) => row.value as { id: string; rootPath: string });
    const roots = projects.map((project) => project.rootPath);
    for (const row of runtime.journal.db
      .prepare(
        'SELECT session_id,project_id FROM session_execution WHERE workspace_id=? AND user_id=? AND machine_id=?',
      )
      .all(runtime.workspace.id, runtime.workspace.userId, runtime.workspace.machineId)) {
      const project = projects.find((p) => p.id === row.project_id);
      if (!project) continue;
      try {
        roots.push(
          runtime.executions.lease({
            workspaceId: runtime.workspace.id,
            userId: runtime.workspace.userId,
            machineId: runtime.workspace.machineId,
            localProjectId: project.id,
            sessionId: String(row.session_id),
            rootPath: project.rootPath,
          }).rootPath,
        );
      } catch {
        /* Inactive execution directories cannot authorize reads. */
      }
    }
    return roots;
  },
  privateRoots: [
    dirname(runtimeFile),
    dirname(configPath),
    resolve(values['github-config-dir'] ?? dirname(runtimeFile)),
  ],
  changed: () => {
    if (!configurationOnly)
      broadcast({ type: 'skills-changed', workspaceId: runtime.workspace.id });
  },
});
if (configurationOnly) {
  let exitCode = 0;
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      assert(bytes <= 16 * 1024, 413, configurationLabel + ' 本机配置请求过大');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = values['skills-config-stdin']
      ? skillsConfig.handle(input)
      : values['preview-config-stdin']
        ? previewConfig.handle(input)
        : await githubConfig.handle(input);
    writeFileSync(process.stdout.fd, JSON.stringify(result) + '\n');
  } catch (error) {
    exitCode = 1;
    writeFileSync(
      process.stdout.fd,
      JSON.stringify({
        error: error instanceof AppError ? error.message : configurationLabel + ' 本机配置请求无效',
      }) + '\n',
    );
  } finally {
    runtime.close();
  }
  process.exit(exitCode);
}
const workspaces = new Map<string, HostWorkspace>(),
  journal = runtime.journal;
const previewRenderer = createPreviewRenderer();
const notifications = new NotificationDispatcher({ hosts: () => workspaces.values() });
const nativeGeneration = {},
  nativeChannel = 'native:' + runtime.workspace.machineId;
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
      host = new HostWorkspace(
        runtime,
        acpDriver,
        hello,
        (sessionId) => {
          broadcast({ type: 'changed', workspaceId: runtime.workspace.id, sessionId });
          notifications.drain();
        },
        undefined,
        undefined,
        undefined,
        { config: githubConfig },
        undefined,
        { config: previewConfig, driver: previewRenderer },
        { config: skillsConfig },
      );
      workspaces.set(runtime.workspace.id, host);
    }
    if (!projectsRegistered) {
      for (const project of values.project ?? []) runtime.registerProject(resolve(project));
      for (const agentType of values['builtin-agent'] ?? []) {
        assert(['codex', 'claude'].includes(agentType), 400, '仅支持 Codex 或 Claude');
        const id = 'personal-' + agentType;
        const base = {
          id,
          name: agentType === 'codex' ? 'Codex' : 'Claude',
          machineId,
          cliType: 'builtin',
          agentType,
        };
        runtime.registerAgent(
          id,
          withLocalCodex(base, agentType === 'codex' ? localCodexPath() : undefined),
        );
      }
      runtime.saveMachine();
      projectsRegistered = true;
    }
    host.updateCatalogue();
    ready = true;
    hello();
    notifications.drain();
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
      if (stopped || target.socket !== ws) return;
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready' && ready && !target.local) {
        notifications.connect(
          relayNotificationChannel(target.config.id, target.config.server),
          ws,
          'relay',
          (event) => {
            if (
              stopped ||
              target.socket !== ws ||
              ws.readyState !== WebSocket.OPEN ||
              ws.bufferedAmount > 1024 * 1024
            )
              return false;
            ws.send(JSON.stringify({ type: 'notification', event }), () => {});
            return true;
          },
        );
        notifications.drain();
      }
      if (m.type === 'notification-ack' && !target.local) {
        notifications.acknowledge(
          relayNotificationChannel(target.config.id, target.config.server),
          ws,
          m,
        );
        notifications.drain();
        return;
      }
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
            result = await workspace.refreshAgentOptions(
              m.params.agentId,
              m.localProjectId,
              m.params.sessionId,
            );
          else if (m.method === 'session')
            result = await workspace.read(m.params.sessionId, m.params.version, m.localProjectId);
          else if (m.method === 'skills-read') {
            const input = skillsReadSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readSkills(input, m.localProjectId);
          } else if (m.method === 'preview-read') {
            const input = previewReadSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readPreview(input, m.localProjectId);
          } else if (m.method === 'preview-action') {
            const input = previewActionSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.previewAction(input, m.localProjectId);
          } else if (m.method === 'preview-inspect') {
            const input = previewInspectSchema.parse(m.params);
            assert(input.request.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.inspectPreview(input, m.localProjectId);
          } else if (m.method === 'preview-close') {
            const input = previewCloseSchema.parse(m.params);
            assert(input.request.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.closePreview(input, m.localProjectId);
          } else if (m.method === 'github-write-read') {
            const input = githubWriteReadSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readGithubWrite(input, m.localProjectId);
          } else if (m.method === 'github-write-action') {
            const input = githubWriteActionSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.githubWriteAction(input, m.localProjectId);
          } else if (m.method === 'github-write-inspect') {
            const input = githubWriteInspectSchema.parse(m.params);
            assert(input.request.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.inspectGithubWrite(input, m.localProjectId);
          } else if (m.method === 'github-write-abandon') {
            const input = githubWriteAbandonSchema.parse(m.params);
            assert(input.request.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.abandonGithubWrite(input, m.localProjectId);
          } else if (m.method === 'github-read') {
            const input = githubReadSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readGithub(input, m.localProjectId);
          } else if (m.method === 'github-action' || m.method === 'github-abandon') {
            const input = githubActionSchema.parse(m.params);
            assert(input.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await (m.method === 'github-abandon'
              ? workspace.abandonGithub(input, m.localProjectId)
              : workspace.githubAction(input, m.localProjectId));
          } else if (m.method === 'mutate') {
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
          } else if (m.method === 'git-state') {
            const body = gitStateReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readGitState(body, m.localProjectId);
          } else if (m.method === 'git-action') {
            const body = gitActionSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.gitAction(body, m.localProjectId);
          } else if (m.method === 'fork-options') {
            const body = forkOptionsReadSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.readForkOptions(body, m.localProjectId);
          } else if (m.method === 'fork-action') {
            const body = sessionForkSchema.parse(m.params);
            assert(body.workspaceId === m.workspaceId, 400, '工作区不匹配');
            result = await workspace.forkSession(body, m.localProjectId);
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
                ([
                  'mutate',
                  'session-action',
                  'attachment-action',
                  'git-action',
                  'fork-action',
                  'github-action',
                  'github-abandon',
                  'github-write-action',
                  'preview-action',
                ].includes(m.method) &&
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
    if (!target.local)
      notifications.disconnect(
        relayNotificationChannel(target.config.id, target.config.server),
        ws,
      );
    if (target.socket !== ws) return;
    for (const host of workspaces.values()) host.previewManager.invalidate();
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
  previewBlockedOrigins.add(origin);
  localApp.setOrigin(origin);
  targets.push({
    config: { server: origin, ...device },
    local: true,
    watches: new Map(),
    revoked: false,
  });
  process.send!({ type: 'local-ready', origin, secret });
  notifications.connect(nativeChannel, nativeGeneration, 'native', (event) => {
    if (stopped || !process.connected || !process.send) return false;
    process.send({ type: 'notification', event }, undefined, undefined, () => {});
    return true;
  });
  process.on('message', (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'skills-config'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)
      )
        return;
      if (stopped || !process.connected) return;
      try {
        const state = skillsConfig.handle(request.action);
        process.send?.({
          type: 'skills-config-result',
          requestId: request.requestId,
          ok: true,
          state,
        });
      } catch (error) {
        process.send?.({
          type: 'skills-config-result',
          requestId: request.requestId,
          ok: false,
          error:
            error instanceof AppError ? error.message : 'Skills 本机设置操作未完成，请重新读取',
        });
      }
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'preview-config'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)
      )
        return;
      const requestId = request.requestId;
      if (stopped || !process.connected) return;
      try {
        const state = previewConfig.handle(request.action);
        process.send?.({ type: 'preview-config-result', requestId, ok: true, state });
      } catch (error) {
        process.send?.({
          type: 'preview-config-result',
          requestId,
          ok: false,
          error: error instanceof AppError ? error.message : '预览本机设置操作未完成，请重新读取',
        });
      }
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'github-config'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)
      )
        return;
      const requestId = request.requestId;
      void githubConfig.handle(request.action).then(
        (state) => {
          if (!stopped && process.connected)
            process.send?.({ type: 'github-config-result', requestId, ok: true, state });
        },
        (error) => {
          if (!stopped && process.connected)
            process.send?.({
              type: 'github-config-result',
              requestId,
              ok: false,
              error:
                error instanceof AppError ? error.message : 'GitHub 本机设置操作未完成，请重新读取',
            });
        },
      );
      return;
    }
    notifications.acknowledge(nativeChannel, nativeGeneration, message);
    notifications.drain();
  });
  process.on('disconnect', () => {
    notifications.disconnect(nativeChannel, nativeGeneration);
    for (const host of workspaces.values()) host.previewManager.invalidate();
  });
}
if (
  config &&
  (values.server === undefined ||
    (values.server && config.server === new URL(values.server).origin))
)
  targets.push({ config, local: false, watches: new Map(), revoked: false });
reportHealth();
const refreshTimer = setInterval(() => void refresh(), 10000);
const notificationTimer = setInterval(() => notifications.drain(), 2000);
for (const target of targets) connect(target);
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(refreshTimer);
  clearInterval(notificationTimer);
  notifications.close();
  for (const target of targets) {
    clearTimeout(target.retry);
    target.socket?.terminate();
  }
  for (const w of workspaces.values()) w.close();
  await previewRenderer.closeAll();
  await localApp?.close();
  localStore?.close();
  runtime.close();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
