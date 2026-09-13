import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { HostWorkspace } from './host-workspace';
import { acquireRuntimeLock } from '../runtime/lock';
import { RuntimeStore } from '../runtime/store';
import { acpDriver } from '../runtime/acp';
import { localCodexPath, withLocalCodex } from './local-codex';
import { Store, token } from '../relay/accounts';
import { createApp } from '../relay/http';
import { AppError, assert, id, PROTOCOL } from '../protocol';
import { HostCommandDispatcher } from './host-command';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  actorKey,
  actorSchema,
  attentionContextSchema,
  attentionContinueSchema,
  attentionDispositionSchema,
  attentionListQuerySchema,
  attentionPermissionSchema,
  attentionSeenSchema,
  type AttentionActor,
  type AttentionContext,
} from '../attention';
import { EncryptedHostTransport, openSecureHostEndpoint } from './encrypted-host';
import { HostProductCatalog } from './host-product-catalog';
import { encryptedHostCatalogSchema } from './encrypted-host-command';
import { NotificationDispatcher, relayNotificationChannel } from './notification-dispatch';
import { GitHubConfig } from '../runtime/github-config';
import { PreviewConfig, type PreviewLocalTarget } from '../runtime/preview-config';
import { createPreviewRenderer } from '../runtime/preview-renderer';
import { SkillsConfig } from '../runtime/skills-config';
import { McpSettings } from '../runtime/mcp-settings';
import { AgentSettings } from '../runtime/agent-settings';
import { taskAuthoritySchema } from '../task-protocol';
import {
  assertLocalCliConnectionPath,
  publishLocalCliConnection,
  localCliProof,
} from './local-cli-connection';
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
    local: { type: 'boolean' },
    'public-dir': { type: 'string' },
    'github-config-dir': { type: 'string' },
    'github-config-stdin': { type: 'boolean' },
    'preview-config-stdin': { type: 'boolean' },
    'skills-config-stdin': { type: 'boolean' },
    'agent-config-stdin': { type: 'boolean' },
    'mcp-config-stdin': { type: 'boolean' },
    'secure-endpoint': { type: 'string' },
    'secure-connection': { type: 'string' },
  },
});
const configurationOnly =
  values['github-config-stdin'] ||
  values['preview-config-stdin'] ||
  values['skills-config-stdin'] ||
  values['agent-config-stdin'] ||
  values['mcp-config-stdin'];
const secureMode =
  values['secure-endpoint'] !== undefined || values['secure-connection'] !== undefined;
let secureProjectRoots = (): string[] => (values.project ?? []).map((path) => resolve(path));
if (
  secureMode &&
  (!values['secure-endpoint'] ||
    !values['secure-connection'] ||
    values.desktop ||
    values.local ||
    values.pair ||
    configurationOnly)
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({
      error: '加密主机需要同时指定私有设备和连接文件，不能混用本机、桌面、旧配对或配置命令',
    }) + '\n',
  );
  process.exit(1);
}
const secureEndpoint = secureMode
  ? await openSecureHostEndpoint({
      endpointFile: values['secure-endpoint']!,
      connectionFile: values['secure-connection']!,
      server: values.server,
      projectRoots: () => secureProjectRoots(),
    })
  : undefined;
process.once('exit', () => secureEndpoint?.close());
let secureTransport: EncryptedHostTransport | undefined;
if (
  values.local &&
  (values.desktop || values.pair || values.server !== undefined || configurationOnly)
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: '--local 不能同时使用桌面、远程连接、配对或本机配置命令' }) + '\n',
  );
  process.exit(1);
}
const configurationLabel = values['mcp-config-stdin']
  ? 'MCP'
  : values['agent-config-stdin']
    ? 'Agent'
    : values['skills-config-stdin']
      ? 'Skills'
      : values['preview-config-stdin']
        ? '预览'
        : 'GitHub';
if (
  values['mcp-config-stdin'] &&
  (values.desktop ||
    values.pair ||
    values['agent-config-stdin'] ||
    values['skills-config-stdin'] ||
    values['preview-config-stdin'] ||
    values['github-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'MCP 本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
  );
  process.exit(1);
}
if (
  values['agent-config-stdin'] &&
  (values.desktop ||
    values.pair ||
    values['github-config-stdin'] ||
    values['preview-config-stdin'] ||
    values['skills-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'Agent 本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
  );
  process.exit(1);
}
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
const configSchema = z.object({
  server: z.string().url(),
  id,
  token: z.string().min(1).max(1024),
  actor: actorSchema.optional(),
});
type Config = z.infer<typeof configSchema>;
const configPath = resolve(values.config ?? '.data/bridge-v3.json');
function saveConfig(value: Config) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = configPath + '.tmp-' + crypto.randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, configPath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
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
    redirect: 'error',
  });
  const result = (await r.json()) as any;
  if (!r.ok) throw new Error(result.error ?? '配对失败');
  config = configSchema.parse({
    server: url.origin,
    id: result.id,
    token: result.token,
    actor: result.actor,
  });
  assert(!config.actor || config.actor.kind === 'relay', 400, '远程配对身份无效');
  saveConfig(config);
  console.log('设备已配对');
} else if (!secureMode) {
  try {
    config = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (e) {
    if (!values.desktop && !values.local && !configurationOnly) throw e;
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
secureProjectRoots = () => [
  ...(values.project ?? []).map((path) => resolve(path)),
  ...runtime.machine
    .scan({ prefix: ['localProject'] })
    .map((row) => (row.value as { rootPath: string }).rootPath),
  // Reserve the entire managed tree before a future session creates its cwd.
  join(dirname(runtimeFile), 'worktrees'),
  // Persisted execution roots can survive a runtime-directory move. Exclude
  // both planned roots and current cwd, including operations awaiting recovery.
  ...runtime.journal.db
    .prepare(
      "SELECT json_extract(record,'$.plan.targetPath') AS root,json_extract(record,'$.managed.cwd') AS cwd FROM session_execution",
    )
    .all()
    .flatMap((row) =>
      [row.root, row.cwd].filter((path): path is string => typeof path === 'string'),
    ),
];
secureEndpoint?.current();
const agentSettings = new AgentSettings(runtime, acpDriver, () => {
  if (!configurationOnly) {
    for (const host of workspaces.values()) host.updateCatalogue();
    hello();
  }
});
const mcpSettings = new McpSettings(runtime, () => {
  if (!configurationOnly) {
    for (const host of workspaces.values()) host.invalidateMcp();
    broadcast({ type: 'mcp-changed', workspaceId: runtime.workspace.id });
  }
});
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
if (secureEndpoint) previewBlockedOrigins.add(secureEndpoint.connection.origin);
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
    ...(secureMode
      ? [dirname(values['secure-endpoint']!), dirname(values['secure-connection']!)]
      : []),
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
      assert(
        bytes <= (values['agent-config-stdin'] || values['mcp-config-stdin'] ? 64 : 16) * 1024,
        413,
        configurationLabel + ' 本机配置请求过大',
      );
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = values['mcp-config-stdin']
      ? await mcpSettings.handle(input)
      : values['agent-config-stdin']
        ? await agentSettings.handle(input)
        : values['skills-config-stdin']
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
    await agentSettings.close();
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
  attentionReady?: boolean;
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
    relay: secureEndpoint
      ? secureTransport?.ready
        ? 'connected'
        : 'unavailable'
      : !remote
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
  if (secureEndpoint) {
    try {
      secureEndpoint.current();
    } catch {
      void stop();
      return;
    }
  }
  if (ready)
    for (const target of targets)
      send(target.socket, {
        type: 'hello',
        protocol: PROTOCOL,
        machineId,
        workspaces: [...workspaces.values()].filter((w) => !w.closed).map((w) => w.workspace),
        ...(target.config.actor ? { attentionActor: target.config.actor } : {}),
      });
}
function attentionChanged(actor: AttentionActor, sessionId: string) {
  for (const target of targets)
    if (
      !target.revoked &&
      target.attentionReady &&
      target.config.actor &&
      actorKey(target.config.actor) === actorKey(actor)
    )
      send(target.socket, {
        type: 'attention-changed',
        actor,
        workspaceId: runtime.workspace.id,
        sessionId,
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
    secureEndpoint?.current();
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
      host.setAttentionListener(attentionChanged);
      workspaces.set(runtime.workspace.id, host);
    }
    if (!projectsRegistered) {
      for (const project of values.project ?? []) runtime.registerProject(resolve(project));
      for (const agentType of values['builtin-agent'] ?? []) {
        assert(['codex', 'claude'].includes(agentType), 400, '仅支持 Codex 或 Claude');
        const id = 'personal-' + agentType;
        // A local toggle/removal takes precedence over repeated startup flags.
        if (agentSettings.wasConfigured(id)) continue;
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
    secureEndpoint?.current();
    host.updateCatalogue();
    ready = true;
    hello();
    notifications.drain();
  } catch {
    ready = false;
    broadcast({ type: 'unavailable' });
    if (secureEndpoint) {
      try {
        secureEndpoint.current();
      } catch {
        void stop();
      }
    }
  } finally {
    refreshing = false;
    reportHealth();
  }
}
const commands = new HostCommandDispatcher({
  ready: () => ready,
  workspace: (id) => workspaces.get(id),
  hasOperation: (operationId) => journal.has(operationId),
});
async function pinLegacyIdentity(target: Target) {
  if (target.config.actor || target.local) return;
  const response = await fetch(new URL('/api/device-context', target.config.server), {
    headers: { Authorization: 'Bearer ' + target.config.token },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 404) return;
  if ([401, 403].includes(response.status)) {
    target.revoked = true;
    throw new Error('设备授权已失效，请重新配对');
  }
  if (!response.ok) throw new Error('暂时无法确认待办账号身份');
  const identity = z
    .object({ executionDeviceId: id, actor: actorSchema })
    .parse(await response.json());
  if (identity.executionDeviceId !== target.config.id || identity.actor.kind !== 'relay') {
    target.revoked = true;
    throw new Error('待办账号身份与原配对不匹配，请重新配对');
  }
  const next = { ...target.config, actor: identity.actor };
  saveConfig(next);
  target.config = next;
}
async function connect(target: Target) {
  if (stopped || target.revoked) return;
  const server = new URL(target.config.server);
  assert(
    !server.username &&
      !server.password &&
      (server.protocol === 'https:' ||
        (server.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))),
    400,
    '远程连接需要不含凭据的 HTTPS 地址',
  );
  try {
    await pinLegacyIdentity(target);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '无法确认待办账号身份');
  }
  if (stopped || target.revoked) return;
  target.attentionReady = false;
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
      if (stopped || target.socket !== ws || target.revoked) return;
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') {
        target.attentionReady = false;
        if (m.actor !== undefined && target.config.actor) {
          const actor = actorSchema.parse(m.actor);
          if (actorKey(actor) !== actorKey(target.config.actor)) {
            target.revoked = true;
            ws.close(1008, 'identity changed');
            throw new Error('服务账号身份已改变，请重新配对');
          }
          target.attentionReady = [ATTENTION_FEATURE, ACTOR_FEATURE, FOLLOWUP_FEATURE].every(
            (feature) =>
              Array.isArray(m.attentionFeatures) && m.attentionFeatures.includes(feature),
          );
        }
      }
      if (m.type === 'ready' && ready && !target.local) {
        notifications.connect(
          relayNotificationChannel(target.config.id, target.config.server),
          ws,
          'relay',
          (event) => {
            if (
              stopped ||
              target.revoked ||
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
        const command = {
          method: m.method,
          workspaceId: m.workspaceId,
          localProjectId: m.localProjectId,
          params: m.params,
        };
        let receiptContext: AttentionContext | undefined;
        try {
          const workspace = workspaces.get(m.workspaceId);
          assert(ready && workspace && !workspace.closed, 409, '本机执行服务不可达');
          let result: unknown;
          if (typeof m.method === 'string' && m.method.startsWith('attention-')) {
            assert(target.attentionReady && target.config.actor, 409, '待办账号身份尚未确认');
            const context = attentionContextSchema.parse(m.context);
            assert(
              actorKey(context.actor) === actorKey(target.config.actor) &&
                context.actor.kind === (target.local ? 'local' : 'relay') &&
                context.executionDeviceId === target.config.id &&
                context.machineId === machineId &&
                context.runtimeWorkspaceId === m.workspaceId &&
                context.runtimeWorkspaceId === workspace.workspace.id &&
                context.localProjectId === m.localProjectId,
              403,
              '待办请求与当前授权连接不匹配',
            );
            assert(
              workspace.workspace.projects.some((project) => project.id === context.localProjectId),
              404,
              '项目副本已从执行电脑移除',
            );
            if (context.sessionId)
              workspace.checkProject(context.sessionId, context.localProjectId);
            receiptContext = context;
            const attentionAuthority = {
              ...taskAuthoritySchema.parse({
                serverOrigin: target.config.server,
                ownerId: context.actor.accountId,
                deviceId: target.config.id,
              }),
              current: () => {
                assert(
                  !stopped &&
                    !target.revoked &&
                    target.socket === ws &&
                    ws.readyState === WebSocket.OPEN &&
                    target.attentionReady &&
                    target.config.actor &&
                    actorKey(target.config.actor) === actorKey(context.actor) &&
                    target.config.id === context.executionDeviceId &&
                    target.config.server === attentionAuthority.serverOrigin,
                  409,
                  '待办协作授权的原连接已失效',
                );
              },
            };
            if (m.method === 'attention-list') {
              assert(!context.sessionId, 400, '待办列表必须使用项目集合范围');
              result = await workspace.attentionList(
                context,
                attentionListQuerySchema.parse(m.params),
              );
            } else if (m.method === 'attention-items') {
              assert(context.sessionId, 400, '会话事项列表缺少会话范围');
              result = await workspace.attentionItems(
                context,
                attentionListQuerySchema.parse(m.params),
              );
            } else {
              assert(context.sessionId, 400, '待办操作缺少会话范围');
              const params = z
                .object({ itemId: z.string().min(1).max(1024), input: z.unknown().optional() })
                .strict()
                .parse(m.params);
              switch (m.method) {
                case 'attention-detail':
                  result = await workspace.attentionDetail(context, params.itemId);
                  break;
                case 'attention-seen':
                  result = await workspace.attentionSeen(
                    context,
                    params.itemId,
                    attentionSeenSchema.parse(params.input),
                  );
                  break;
                case 'attention-disposition':
                  result = await workspace.attentionDisposition(
                    context,
                    params.itemId,
                    attentionDispositionSchema.parse(params.input),
                  );
                  break;
                case 'attention-continue':
                  result = await workspace.attentionContinue(
                    context,
                    params.itemId,
                    attentionContinueSchema.parse(params.input),
                    attentionAuthority,
                  );
                  break;
                case 'attention-permission':
                  result = await workspace.attentionPermission(
                    context,
                    params.itemId,
                    attentionPermissionSchema.parse(params.input),
                    attentionAuthority,
                  );
                  break;
                default:
                  throw new AppError(400, '不支持的待办操作');
              }
            }
          } else {
            const authority =
              m.method !== 'mutate' || m.authorityOwner === undefined
                ? undefined
                : taskAuthoritySchema.parse({
                    serverOrigin: target.config.server,
                    ownerId: m.authorityOwner,
                    deviceId: target.config.id,
                  });
            result = await commands.execute(command, {
              authority: authority
                ? {
                    ...authority,
                    current: () => {
                      assert(
                        !stopped &&
                          !target.revoked &&
                          target.socket === ws &&
                          ws.readyState === WebSocket.OPEN &&
                          target.config.server === authority.serverOrigin &&
                          target.config.id === authority.deviceId,
                        409,
                        '协作授权的原连接已失效',
                      );
                    },
                  }
                : undefined,
            });
          }
          send(ws, { type: 'response', requestId: m.requestId, result });
        } catch (e) {
          let attentionRejected = false;
          if (
            receiptContext &&
            [
              'attention-seen',
              'attention-disposition',
              'attention-continue',
              'attention-permission',
            ].includes(m.method)
          ) {
            const operationId =
              m.method === 'attention-continue'
                ? m.params?.input?.mutation?.operationId
                : m.params?.input?.operationId;
            if (id.safeParse(operationId).success) {
              try {
                // New sends and approvals commit this actor-scoped receipt in
                // the same transaction as the original execution journal.
                attentionRejected = !runtime.attention.hasReceipt(
                  receiptContext.actor,
                  operationId,
                );
              } catch {
                // A failed receipt read cannot prove the original operation absent.
              }
            }
          }
          const error = commands.error(command, e);
          send(ws, {
            type: 'response',
            requestId: m.requestId,
            error: { ...error, rejected: error.rejected || attentionRejected },
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
    target.attentionReady = false;
    for (const host of workspaces.values()) {
      host.previewManager.invalidate();
      host.taskManager.invalidateUnavailable();
      host.invalidateMcp();
    }
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
    if (!stopped && !target.revoked) target.retry = setTimeout(() => void connect(target), 2000);
  });
}
let localApp: ReturnType<typeof createApp> | undefined, localStore: Store | undefined;
let cliConnection: ReturnType<typeof publishLocalCliConnection> | undefined;
if (values.desktop || values.local) {
  try {
    // A loopback-only relay keeps the same UI usable without a public server.
    // Persist product organization across restarts; session data belongs to the Moor execution host.
    // Native main receives its credential over the private child-process IPC channel.
    if (values.desktop) assert(Boolean(process.send), 500, '本机界面必须由客户端启动');
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const applicationRoots: string[] = [];
    for (let path = moduleDirectory; dirname(path) !== path; path = dirname(path))
      if (basename(path).toLowerCase().endsWith('.app')) applicationRoots.push(path);
    const connectionOptions = {
      projectRoots: () => [
        ...(values.project ?? []).map((path) => resolve(path)),
        // Managed execution directories are private runtime children, not
        // separately registered projects; credentials must stay outside them too.
        join(dirname(runtimeFile), 'worktrees'),
        ...runtime.machine
          .scan({ prefix: ['localProject'] })
          .map((row) => (row.value as { rootPath: string }).rootPath),
      ],
      distributionRoots: [
        moduleDirectory,
        ...applicationRoots,
        ...(basename(moduleDirectory) === 'runtime' ? [dirname(moduleDirectory)] : []),
      ],
    };
    let cliEnabled = true;
    const cliUnavailable = () => {
      const message =
        '本机 CLI 不可用：请将私有配置目录移到项目和程序发行目录外，并确保仅本用户可写。';
      console.error(message);
      if (values.desktop && process.connected) process.send?.({ type: 'cli-unavailable' });
    };
    try {
      assertLocalCliConnectionPath(configPath + '.cli.json', connectionOptions);
    } catch (error) {
      if (!values.desktop) throw error;
      cliEnabled = false;
      cliUnavailable();
    }
    const instanceId = 'instance_' + randomUUID();
    localStore = new Store(configPath + '.catalog.sqlite');
    chmodSync(configPath + '.catalog.sqlite', 0o600);
    localStore.db.prepare('DELETE FROM login').run();
    const secret = localStore.hasAccount()
      ? localStore.createLogin('local-desktop')
      : await localStore.setup('local@localhost.invalid', token(), 'local-desktop');
    const owner = localStore.owner(secret),
      device = localStore.localDevice(owner, values.name ?? hostname());
    let cliProofSecret: string | undefined;
    localApp = createApp(localStore, {
      origin: 'http://127.0.0.1:0',
      setupToken: token(),
      publicDir: values['public-dir'],
      localOnly: true,
      localInstanceId: instanceId,
      localInstanceProof: (challenge) => {
        assert(cliProofSecret, 404, '本机 CLI 连接不可用');
        assert(localStore?.owner(cliProofSecret) === owner, 404, '本机 CLI 连接不可用');
        return localCliProof(instanceId, challenge, cliProofSecret);
      },
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
      config: {
        server: origin,
        ...device,
        actor: { kind: 'local', authorityId: localStore.authorityId, accountId: owner },
      },
      local: true,
      watches: new Map(),
      revoked: false,
    });
    if (cliEnabled) {
      const cliSecret = localStore.createLogin(owner);
      cliProofSecret = cliSecret;
      try {
        cliConnection = publishLocalCliConnection(
          configPath + '.cli.json',
          {
            version: 1,
            instanceId,
            origin,
            secret: cliSecret,
            ownerId: owner,
            deviceId: device.id,
            runtimeWorkspaceId: runtime.workspace.id,
            machineId: runtime.workspace.machineId,
            userId: runtime.workspace.userId,
          },
          connectionOptions,
        );
      } catch (error) {
        cliProofSecret = undefined;
        localStore.logout(cliSecret);
        if (!values.desktop) throw error;
        cliUnavailable();
      }
    }
    process.once('exit', () => cliConnection?.remove());
    if (values.desktop) process.send!({ type: 'local-ready', origin, secret });
    else console.log('本机 CLI 连接已就绪');
  } catch (error) {
    stopped = true;
    cliConnection?.remove();
    // Startup has not connected a host socket or exposed the native credential.
    // Revoke every bootstrap login even if listening or publication failed.
    try {
      localStore?.db.prepare('DELETE FROM login').run();
    } catch {}
    notifications.close();
    for (const workspace of workspaces.values()) workspace.close();
    await Promise.allSettled([
      agentSettings.close(),
      previewRenderer.closeAll(),
      localApp?.close(),
    ]);
    try {
      localStore?.close();
    } catch {}
    try {
      runtime.close();
    } catch {}
    throw error instanceof AppError
      ? error
      : new AppError(500, '本机连接启动失败，请检查本机私有目录和端口');
  }
}
if (values.desktop) {
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
      message.type === 'mcp-config'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ||
        stopped ||
        !process.connected
      )
        return;
      const requestId = request.requestId;
      void Promise.resolve()
        .then(() => mcpSettings.handle(request.action))
        .then(
          (state) => {
            if (!stopped && process.connected)
              process.send?.({ type: 'mcp-config-result', requestId, ok: true, state });
          },
          (error) => {
            if (!stopped && process.connected)
              process.send?.({
                type: 'mcp-config-result',
                requestId,
                ok: false,
                error:
                  error instanceof AppError ? error.message : 'MCP 本机设置未能确认，请重新读取',
              });
          },
        );
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'agent-config'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ||
        stopped ||
        !process.connected
      )
        return;
      const requestId = request.requestId;
      void agentSettings.handle(request.action).then(
        (state) => {
          if (!stopped && process.connected)
            process.send?.({ type: 'agent-config-result', requestId, ok: true, state });
        },
        (error) => {
          if (!stopped && process.connected)
            process.send?.({
              type: 'agent-config-result',
              requestId,
              ok: false,
              error:
                error instanceof AppError ? error.message : 'Agent 本机设置操作未完成，请重新读取',
            });
        },
      );
      return;
    }
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
    void agentSettings.close();
    notifications.disconnect(nativeChannel, nativeGeneration);
    for (const host of workspaces.values()) host.previewManager.invalidate();
  });
}
if (
  config &&
  !secureMode &&
  !values.local &&
  (values.server === undefined ||
    (values.server && config.server === new URL(values.server).origin))
)
  targets.push({ config, local: false, watches: new Map(), revoked: false });
reportHealth();
const refreshTimer = setInterval(() => void refresh(), 10000);
const notificationTimer = setInterval(() => notifications.drain(), 2000);
for (const target of targets) void connect(target);
if (secureEndpoint) {
  await refresh();
  if (ready) {
    const runtimeCatalog = () => {
      assert(ready && !stopped, 503, '加密主机暂不可用');
      secureEndpoint.current();
      return encryptedHostCatalogSchema.parse({
        catalogVersion: 1,
        machineId,
        workspaces: [...workspaces.values()]
          .filter((host) => !host.closed)
          .map((host) => ({
            ...host.workspace,
            // Workbench Actor proof and its seven methods still need explicit
            // encrypted protocol support before advertising these capabilities.
            features: host.workspace.features?.filter(
              (feature) => ![ATTENTION_FEATURE, ACTOR_FEATURE, FOLLOWUP_FEATURE].includes(feature),
            ),
          })),
      });
    };
    const products = new HostProductCatalog({
      db: journal.db,
      authority: {
        serverOrigin: secureEndpoint.connection.origin,
        accountId: secureEndpoint.connection.owner,
        rootKeyId: secureEndpoint.current().checkpoint.rootKeyId,
        hostDeviceId: secureEndpoint.deviceId,
      },
      runtime: runtimeCatalog,
    });
    products.synchronize();
    const invalidateAuthorizations = () => {
      for (const host of workspaces.values()) {
        host.previewManager.invalidateUnavailable();
        host.taskManager.invalidateUnavailable();
        host.invalidateMcp();
      }
    };
    secureTransport = new EncryptedHostTransport({
      endpoint: secureEndpoint,
      dispatcher: commands,
      products,
      invalidated: invalidateAuthorizations,
      catalog: () => {
        return {
          ...runtimeCatalog(),
          catalogVersion: 2,
          products: products.read(),
        };
      },
      closed: () => {
        for (const host of workspaces.values()) host.previewManager.invalidate();
        invalidateAuthorizations();
        try {
          secureEndpoint.current();
        } catch {
          void stop();
        }
        reportHealth();
      },
    });
  }
}
async function stop() {
  if (stopped) return;
  stopped = true;
  cliConnection?.remove();
  const checksClosed = agentSettings.close();
  clearInterval(refreshTimer);
  clearInterval(notificationTimer);
  notifications.close();
  secureTransport?.close();
  secureEndpoint?.close();
  for (const target of targets) {
    clearTimeout(target.retry);
    target.socket?.terminate();
  }
  for (const w of workspaces.values())
    try {
      w.close();
    } catch (error) {
      console.error(error);
    }
  await previewRenderer.closeAll();
  await localApp?.close();
  localStore?.close();
  await checksClosed;
  runtime.close();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
