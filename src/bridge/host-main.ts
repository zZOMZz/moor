import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { HostWorkspace } from './host-workspace';
import { acquireRuntimeLock } from '../runtime/lock';
import { RuntimeStore } from '../runtime/store';
import { acpDriver } from '../runtime/acp';
import { localCodexPath, withLocalCodex } from './local-codex';
import { Store, token } from '../relay/accounts';
import { createApp } from '../relay/http';
import { AppError, assert, id, mutationSchema, sessionActionSchema, PROTOCOL } from '../protocol';
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
  },
});
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
    if (!values.desktop && !values['github-config-stdin']) throw e;
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
      if (!values['github-config-stdin'])
        broadcast({ type: 'github-changed', workspaceId: runtime.workspace.id });
    },
  },
);
if (values['github-config-stdin']) {
  let exitCode = 0;
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      assert(bytes <= 16 * 1024, 413, 'GitHub 本机配置请求过大');
      chunks.push(chunk);
    }
    const result = await githubConfig.handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    writeFileSync(process.stdout.fd, JSON.stringify(result) + '\n');
  } catch (error) {
    exitCode = 1;
    writeFileSync(
      process.stdout.fd,
      JSON.stringify({
        error: error instanceof AppError ? error.message : 'GitHub 本机配置请求无效',
      }) + '\n',
    );
  } finally {
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
      );
      host.setAttentionListener(attentionChanged);
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
    notifications.drain();
  } catch {
    ready = false;
    broadcast({ type: 'unavailable' });
  } finally {
    refreshing = false;
    reportHealth();
  }
}
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
                  );
                  break;
                case 'attention-permission':
                  result = await workspace.attentionPermission(
                    context,
                    params.itemId,
                    attentionPermissionSchema.parse(params.input),
                  );
                  break;
                default:
                  throw new AppError(400, '不支持的待办操作');
              }
            }
          } else if (m.method === 'sessions') result = workspace.list(m.localProjectId);
          else if (m.method === 'agent-options')
            result = await workspace.refreshAgentOptions(m.params.agentId, m.localProjectId);
          else if (m.method === 'session')
            result = await workspace.read(m.params.sessionId, m.params.version, m.localProjectId);
          else if (m.method === 'github-write-read') {
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
          send(ws, {
            type: 'response',
            requestId: m.requestId,
            error: {
              status: e instanceof AppError ? e.status : e instanceof z.ZodError ? 400 : 502,
              message:
                e instanceof AppError
                  ? e.message
                  : e instanceof z.ZodError
                    ? '请求格式无效'
                    : '本地主机处理失败',
              rejected:
                (e instanceof AppError && e.rejected) ||
                attentionRejected ||
                ([
                  'mutate',
                  'session-action',
                  'attachment-action',
                  'git-action',
                  'fork-action',
                  'github-action',
                  'github-abandon',
                  'github-write-action',
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
    config: {
      server: origin,
      ...device,
      actor: { kind: 'local', authorityId: localStore.authorityId, accountId: owner },
    },
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
  process.on('disconnect', () => notifications.disconnect(nativeChannel, nativeGeneration));
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
for (const target of targets) void connect(target);
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
  for (const w of workspaces.values())
    try {
      w.close();
    } catch (error) {
      console.error(error);
    }
  await localApp?.close();
  localStore?.close();
  runtime.close();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
