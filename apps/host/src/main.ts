import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { acquireRuntimeLock } from '@moor/protocol/node/exclusive-lock';
import { RuntimeStore } from '@moor/host/persistence/store';
import { acpDriver } from '@moor/host/agents/acp/driver';
import { localCodexPath, withLocalCodex } from '@moor/host/agents/acp/local-codex';
import { Store, token } from '@moor/gateway/accounts';
import { createApp } from '@moor/gateway/http';
import { AppError, assert, id, PROTOCOL } from '@moor/protocol/protocol';
import { HostCommandDispatcher } from '@moor/host/commands/host-command';
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
} from '@moor/protocol/attention';
import {
  NotificationDispatcher,
  relayNotificationChannel,
} from '@moor/host/integrations/notification-dispatch';
import { GitHubConfig } from '@moor/host/integrations/github/config';
import { SkillsConfig } from '@moor/host/integrations/skills-config';
import { AgentSettings } from '@moor/host/agents/settings';
import { registerDesktopProject } from '@moor/host/projects/registration';
import { HostDeviceMetadata } from '@moor/host/persistence/device-metadata';
import {
  deviceMetadataSchema,
  type DeviceMetadata,
  type DeviceMetadataState,
} from '@moor/protocol/device-metadata';
import { connectionAuthoritySchema } from '@moor/protocol/connection-authority';
import { collaborationContextSchema } from '@moor/protocol/collaboration-protocol';
import {
  assertLocalCliConnectionPath,
  publishLocalCliConnection,
  localCliProof,
} from '@moor/protocol/node/local-cli-connection';
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
  values['github-config-stdin'] || values['skills-config-stdin'] || values['agent-config-stdin'];
if (values['preview-config-stdin'] || values['mcp-config-stdin']) {
  console.error('网页预览与Moor逐回合附加MCP已退场；原私有配置保留，本次未修改或启动服务。');
  process.exit(1);
}
// Retired arguments fail before reading credentials, opening data or connecting.
if (values['secure-endpoint'] !== undefined || values['secure-connection'] !== undefined) {
  console.error('加密主机已退场；本次未读取设备材料或连接其他传输，请保留原数据。');
  process.exit(1);
}
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
const configurationLabel = values['agent-config-stdin']
  ? 'Agent'
  : values['skills-config-stdin']
    ? 'Skills'
    : 'GitHub';
if (
  values['agent-config-stdin'] &&
  (values.desktop || values.pair || values['github-config-stdin'] || values['skills-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'Agent 本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
  );
  process.exit(1);
}
if (
  values['skills-config-stdin'] &&
  (values.desktop || values.pair || values['github-config-stdin'])
) {
  writeFileSync(
    process.stdout.fd,
    JSON.stringify({ error: 'Skills 本机配置命令不能同时启动桌面、配对或其他配置命令' }) + '\n',
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
} else {
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
const agentSettings = new AgentSettings(
  runtime,
  acpDriver,
  () => {
    if (!configurationOnly) {
      for (const host of workspaces.values()) host.updateCatalogue();
      hello();
    }
  },
  undefined,
  configurationOnly
    ? undefined
    : async (agentId, localProjectId) => {
        const host = workspaces.get(runtime.workspace.id);
        assert(host && !configurationOnly, 409, '请先启动本机工作区');
        await host.refreshAgentOptions(agentId, localProjectId, undefined, undefined, true);
        await host.readAgentUsage({ agentId, refresh: true }, localProjectId);
        hello();
      },
);
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
      assert(
        bytes <= (values['agent-config-stdin'] ? 64 : 16) * 1024,
        413,
        configurationLabel + ' 本机配置请求过大',
      );
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = values['agent-config-stdin']
      ? await agentSettings.handle(input)
      : values['skills-config-stdin']
        ? skillsConfig.handle(input)
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
  nameAcknowledged?: DeviceMetadata | null;
};
const targets: Target[] = [];
let stopped = false,
  machineId = runtime.workspace.machineId,
  ready = false,
  refreshing = false,
  projectsRegistered = false;
const deviceMetadata = new HostDeviceMetadata(runtime, values.name ?? hostname());
// A standalone --name is an explicit operator edit. Desktop flags are a legacy
// settings cache and must never overwrite the host's durable name on restart.
if (!values.desktop && values.name && values.name.trim() !== deviceMetadata.read().name)
  deviceMetadata.handle({
    action: 'rename',
    name: values.name,
    expectedRevision: deviceMetadata.read().revision,
  });
function deviceMetadataState(): DeviceMetadataState {
  const metadata = deviceMetadata.read(),
    remote = targets.find((target) => !target.local);
  const ack = remote?.nameAcknowledged;
  const sync = !remote
    ? 'unpaired'
    : remote.revoked
      ? 'revoked'
      : remote.socket?.readyState !== WebSocket.OPEN
        ? 'pending'
        : ack === null
          ? 'unsupported'
          : !ack || ack.revision < metadata.revision
            ? 'pending'
            : ack.revision === metadata.revision && ack.name === metadata.name
              ? 'synced'
              : 'conflict';
  return { metadata, sync };
}
const send = (ws: WebSocket | undefined, v: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(v));
};
function reportHealth() {
  if (!process.send || !process.connected) return;
  const remote = targets.find((t) => !t.local);
  process.send({
    type: 'health',
    deviceMetadata: deviceMetadataState(),
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
    for (const target of targets)
      send(target.socket, {
        type: 'hello',
        protocol: PROTOCOL,
        machineId,
        deviceMetadata: deviceMetadata.read(),
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
        { config: skillsConfig },
      );
      host.setAttentionListener(attentionChanged);
      workspaces.set(runtime.workspace.id, host);
    }
    if (!projectsRegistered) {
      for (const project of values.project ?? []) runtime.registerProject(resolve(project));
      for (const agentType of values['builtin-agent'] ?? []) {
        assert(agentType === 'codex', 400, '仅支持 Codex');
        const id = 'personal-' + agentType;
        const base = {
          id,
          name: 'Codex',
          machineId,
          cliType: 'builtin',
          agentType,
        };
        let codexPath: string | undefined;
        try {
          codexPath = localCodexPath();
        } catch {
          // Invalid or missing local configuration is a preset-level condition.
          // Keep the host ready so the user can install Codex and add it later.
        }
        if (!codexPath) continue;
        // A local toggle/removal takes precedence over repeated startup flags.
        if (agentSettings.wasConfigured(id)) continue;
        runtime.registerAgent(id, withLocalCodex(base, codexPath));
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
  target.nameAcknowledged = undefined;
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
        target.nameAcknowledged =
          m.deviceMetadata === undefined ? null : deviceMetadataSchema.parse(m.deviceMetadata);
        reportHealth();
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
      if (m.type === 'ready' && ready && target.attentionReady && target.config.actor) {
        for (const workspace of workspaces.values()) {
          await workspace.collaboration.resume(target.config.actor, target.config.id, () => {
            assert(
              !stopped &&
                !target.revoked &&
                target.socket === ws &&
                ws.readyState === WebSocket.OPEN,
              409,
              '协作主机连接已失效',
            );
          });
        }
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
        const current = () => {
          assert(
            !stopped && !target.revoked && target.socket === ws && ws.readyState === WebSocket.OPEN,
            409,
            '原请求连接已失效，请核查原操作',
          );
        };
        try {
          current();
          const workspace = workspaces.get(m.workspaceId);
          assert(ready && workspace && !workspace.closed, 409, '本机执行服务不可达');
          let result: unknown;
          if (typeof m.method === 'string' && m.method.startsWith('collaboration-')) {
            const context = collaborationContextSchema.parse(m.context);
            assert(
              target.attentionReady &&
                target.config.actor &&
                actorKey(context.ownerActor) === actorKey(target.config.actor) &&
                context.executionDeviceId === target.config.id &&
                context.machineId === machineId &&
                context.runtimeWorkspaceId === m.workspaceId &&
                context.localProjectId === m.localProjectId,
              403,
              '协作请求与当前主机授权连接不匹配',
            );
            result = await workspace.collaboration.execute(m.method, m.params, context, current);
          } else if (typeof m.method === 'string' && m.method.startsWith('attention-')) {
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
              ...connectionAuthoritySchema.parse({
                serverOrigin: target.config.server,
                ownerId: context.actor.accountId,
                deviceId: target.config.id,
              }),
              current: () => {
                current();
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
                : connectionAuthoritySchema.parse({
                    serverOrigin: target.config.server,
                    ownerId: m.authorityOwner,
                    deviceId: target.config.id,
                  });
            result = await commands.execute(command, {
              current,
              authority: authority
                ? {
                    ...authority,
                    current: () => {
                      current();
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
          current();
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
      device = localStore.localDevice(owner, deviceMetadata.read().name);
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
    if (values.desktop)
      process.send!({
        type: 'local-ready',
        origin,
        secret,
        identity: {
          owner,
          deviceId: device.id,
          workspaceId: runtime.workspace.id,
          machineId: runtime.workspace.machineId,
          userId: runtime.workspace.userId,
        },
      });
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
    await Promise.allSettled([agentSettings.close(), localApp?.close()]);
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
      message.type === 'register-project'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ||
        stopped ||
        !ready ||
        !process.connected
      )
        return;
      try {
        const state = registerDesktopProject(runtime, request.action, [
          dirname(runtimeFile),
          dirname(configPath),
          resolve(values['github-config-dir'] ?? dirname(runtimeFile)),
        ]);
        for (const host of workspaces.values()) host.updateCatalogue();
        hello();
        reportHealth();
        process.send?.({
          type: 'register-project-result',
          requestId: request.requestId,
          ok: true,
          state,
        });
      } catch {
        process.send?.({
          type: 'register-project-result',
          requestId: request.requestId,
          ok: false,
        });
      }
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'device-metadata'
    ) {
      const request = message as { requestId?: unknown; action?: unknown };
      if (
        typeof request.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ||
        stopped ||
        !process.connected
      )
        return;
      try {
        const before = deviceMetadata.read();
        const metadata = deviceMetadata.handle(request.action);
        if (metadata.revision !== before.revision) {
          hello();
          reportHealth();
        }
        process.send?.({
          type: 'device-metadata-result',
          requestId: request.requestId,
          ok: true,
          state: deviceMetadataState(),
        });
      } catch {
        process.send?.({ type: 'device-metadata-result', requestId: request.requestId, ok: false });
      }
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
  });
}
if (
  config &&
  !values.local &&
  (values.server === undefined ||
    (values.server && config.server === new URL(values.server).origin))
)
  targets.push({ config, local: false, watches: new Map(), revoked: false });
reportHealth();
const refreshTimer = setInterval(() => void refresh(), 10000);
const notificationTimer = setInterval(() => notifications.drain(), 2000);
for (const target of targets) void connect(target);
async function stop() {
  if (stopped) return;
  stopped = true;
  cliConnection?.remove();
  const checksClosed = agentSettings.close();
  clearInterval(refreshTimer);
  clearInterval(notificationTimer);
  notifications.close();
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
  await localApp?.close();
  localStore?.close();
  await checksClosed;
  runtime.close();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
