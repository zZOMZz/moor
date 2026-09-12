import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { serveStatic } from './static';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { Store, hash as loginHash, type Device } from './accounts';
import { createHash } from 'node:crypto';
import { RelayNotifications } from './notifications';
import type { WebPushTransport } from './web-push';
import {
  NOTIFICATIONS_FEATURE,
  NOTIFICATION_LIMITS,
  hostNotificationEventSchema,
  notificationEnvelopeSchema,
  notificationIdentity,
  notificationPreferencesSchema,
  pushSubscriptionRequestSchema,
  type HostNotificationEvent,
  type NotificationEnvelope,
} from '../notification-protocol';
import { AppError, assert, helloSchema, mutationSchema, sessionActionSchema } from '../protocol';
import type { RuntimeWorkspace } from '../protocol';
import { workspaceInputSchema, projectInputSchema, replicaAssignmentSchema } from '../catalog';
import {
  FILE_CONTENT_FEATURE,
  projectFileReadSchema,
  projectFileResultSchema,
} from '../content-protocol';
import {
  ATTACHMENTS_FEATURE,
  attachmentActionSchema,
  attachmentReadSchema,
  attachmentReceiptSchema,
  attachmentContentSchema,
} from '../attachment-protocol';
import {
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
  projectTreeReadSchema,
  projectTreeResultSchema,
  projectTurnDiffReadSchema,
  projectTurnDiffResultSchema,
  projectDiffFileReadSchema,
  projectDiffFileResultSchema,
} from '../project-content-protocol';
import {
  QUESTIONS_FEATURE,
  STEER_FEATURE,
  questionAnswerSchema,
  questionReceiptSchema,
  steerRequestSchema,
  steerReceiptSchema,
} from '../interaction-protocol';
import {
  SESSION_SEARCH_FEATURE,
  sessionSearchRequestSchema,
  sessionSearchResultSchema,
} from '../search-protocol';
import {
  GIT_WORKTREE_FEATURE,
  gitStateReadSchema,
  gitStateResultSchema,
  gitActionSchema,
  gitActionReceiptSchema,
} from '../git-protocol';
import {
  SESSION_FORK_FEATURE,
  forkOptionsReadSchema,
  forkOptionsResultSchema,
  sessionForkSchema,
  forkReceiptSchema,
} from '../fork-protocol';
import {
  GITHUB_FEATURE,
  githubReadSchema,
  githubReadResultSchema,
  githubActionSchema,
  githubReceiptSchema,
} from '../github-protocol';
import {
  GITHUB_WRITE_FEATURE,
  githubWriteReadSchema,
  githubWriteReadResultSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
  githubWriteReceiptSchema,
} from '../github-write-protocol';
export function createApp(
  store: Store,
  options: {
    origin: string;
    setupToken: string;
    publicDir?: string;
    localOnly?: boolean;
    pushTransport?: WebPushTransport;
  },
) {
  let origin = new URL(options.origin).origin;
  const bridges = new Map<
    string,
    { socket: WebSocket; ready: boolean; workspaces: RuntimeWorkspace[] }
  >();
  const viewers = new Map<
    WebSocket,
    {
      owner: string;
      secret: string;
      watch?: {
        deviceId: string;
        workspaceId: string;
        sessionId: string;
        localProjectId?: string;
        catalogWorkspaceId?: string;
        replicaId?: string;
      };
    }
  >();
  const commands = new Map<
    string,
    {
      device: string;
      socket: WebSocket;
      method: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failures = new Map<string, { count: number; until: number }>();
  const online = (id: string) =>
    bridges.get(id)?.ready === true && bridges.get(id)?.socket.readyState === WebSocket.OPEN;
  let closing = false;
  function notificationRoute(owner: string, deviceId: string, event: HostNotificationEvent) {
    assert(!closing && online(deviceId), 409, '通知主机不在线');
    const device = store.device(owner, deviceId);
    const workspace = bridges
      .get(deviceId)
      ?.workspaces.find((workspace) => workspace.id === event.workspaceId);
    assert(
      workspace &&
        workspace.userId === event.userId &&
        workspace.machineId === event.machineId &&
        device.machine_id === event.machineId &&
        workspace.features?.includes(NOTIFICATIONS_FEATURE) &&
        workspace.projects.some((project) => project.id === event.localProjectId),
      403,
      '通知执行范围不匹配',
    );
    const spaces = store.catalog.list(owner, (id) =>
      online(id) ? bridges.get(id)!.workspaces : [],
    );
    for (const space of spaces) {
      const host = space.hosts.find(
        (host) =>
          host.deviceId === deviceId &&
          host.runtimeWorkspaceId === event.workspaceId &&
          host.machineId === event.machineId,
      );
      const replica =
        host &&
        space.replicas.find(
          (replica) =>
            replica.hostId === host.id &&
            replica.localProjectId === event.localProjectId &&
            replica.available,
        );
      if (replica) return { catalogWorkspaceId: space.id, replicaId: replica.id };
    }
    throw new AppError(403, '通知项目副本已不可用');
  }
  const notifications = new RelayNotifications(store.db, {
    now: store.now,
    transport: options.pushTransport,
    authorize: (event: NotificationEnvelope) => {
      try {
        const route = notificationRoute(
          event.owner,
          event.deviceId,
          hostNotificationEventSchema.parse(
            Object.fromEntries(
              Object.entries(event).filter(
                ([key]) => !['owner', 'deviceId', 'catalogWorkspaceId', 'replicaId'].includes(key),
              ),
            ),
          ),
        );
        return (
          route.catalogWorkspaceId === event.catalogWorkspaceId &&
          route.replicaId === event.replicaId
        );
      } catch {
        return false;
      }
    },
  });
  async function deliverNotification(
    device: Device,
    socket: WebSocket,
    event: HostNotificationEvent,
  ) {
    try {
      assert(bridges.get(device.id)?.socket === socket, 409, '通知主机连接已变化');
      assert(
        event.eventId ===
          'notification_' + createHash('sha256').update(notificationIdentity(event)).digest('hex'),
        400,
        '通知标识无效',
      );
      const envelope = notificationEnvelopeSchema.parse({
        ...event,
        owner: device.owner,
        deviceId: device.id,
        ...notificationRoute(device.owner, device.id, event),
      });
      assert(
        Buffer.byteLength(JSON.stringify(envelope)) <= NOTIFICATION_LIMITS.payloadBytes,
        413,
        '通知标识超出大小限制',
      );
      // The route can remain identical after reconnect. Keep the originating
      // connection in memory and recheck it after waiting for a provider slot.
      await notifications.deliver(
        envelope,
        () => !closing && bridges.get(device.id)?.socket === socket && online(device.id),
      );
      if (!closing && bridges.get(device.id)?.socket === socket)
        send(socket, { type: 'notification-ack', eventId: event.eventId, status: 'handled' });
    } catch (error) {
      if (!closing && bridges.get(device.id)?.socket === socket)
        send(socket, {
          type: 'notification-ack',
          eventId: event.eventId,
          status:
            error instanceof AppError && [400, 401, 403, 404, 409, 413, 429].includes(error.status)
              ? 'rejected'
              : 'retry',
        });
    }
  }
  const send = (ws: WebSocket, message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 1024 * 1024) ws.close(1013, 'slow client');
      else ws.send(JSON.stringify(message));
    }
  };
  const changed = (owner: string, deviceId: string, workspaceId?: string, room?: unknown) => {
    for (const [ws, v] of viewers)
      if (v.owner === owner) send(ws, { type: 'changed', deviceId, workspaceId, room });
  };
  function rejectFileReads(device: string, socket?: WebSocket) {
    for (const [id, pending] of commands)
      if (
        pending.device === device &&
        [
          'file-content',
          'read-attachment',
          'read-project-tree',
          'read-turn-diff',
          'read-diff-file',
          'search-sessions',
          'git-state',
          'fork-options',
          'github-read',
          'github-write-read',
        ].includes(pending.method) &&
        (!socket || pending.socket === socket)
      ) {
        clearTimeout(pending.timer);
        commands.delete(id);
        pending.reject(new AppError(409, '执行主机连接已变更，请重新读取文件'));
      }
  }
  function request(
    device: string,
    method: string,
    workspaceId: string,
    params: unknown,
    localProjectId?: string,
  ): Promise<unknown> {
    assert(online(device), 409, '执行电脑不可达，指令未送达');
    assert(commands.size < 64, 429, '请求过多，请稍后再试');
    const requestId = crypto.randomUUID(),
      socket = bridges.get(device)!.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        commands.delete(requestId);
        reject(new AppError(504, '执行主机尚未确认，请重试确认同一请求'));
      }, 30000);
      commands.set(requestId, { device, socket, method, resolve, reject, timer });
      send(socket, {
        type: 'request',
        requestId,
        method,
        workspaceId,
        params,
        localProjectId,
      });
    });
  }
  function unwatch(ws: WebSocket) {
    const current = viewers.get(ws)?.watch;
    if (!current) return;
    viewers.get(ws)!.watch = undefined;
    if (![...viewers.values()].some((v) => JSON.stringify(v.watch) === JSON.stringify(current))) {
      const b = bridges.get(current.deviceId);
      if (b) send(b.socket, { type: 'unwatch', ...current });
    }
  }
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('personal='))
      ?.slice(9) ?? '';
  const bearer = (req: IncomingMessage) =>
    req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const loginCookie = (secret: string) =>
    `personal=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`;
  async function body(req: IncomingMessage, maxBytes = 34 * 1024 * 1024) {
    assert(req.headers['content-type']?.startsWith('application/json'), 415, '需要 JSON 请求');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= maxBytes, 413, '请求过大');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new AppError(400, 'JSON 无效');
    }
  }
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const authBody = z.object({
    email: z.string().email().max(200),
    password: z.string().min(1).max(1024),
    setupToken: z.string().optional(),
  });
  const server = createServer(async (req, res) => {
    let scopedActionRequest = false,
      scopedActionDispatched = false,
      scopedRecoveryRequest = false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url ?? '/', origin),
        path = url.pathname;
      scopedActionRequest =
        req.method === 'POST' &&
        /^\/api\/workspaces\/[^/]+\/replicas\/[^/]+\/(?:(git|fork|github|github-write)\/action|github\/abandon)$/.test(
          path,
        );
      scopedRecoveryRequest =
        req.method === 'POST' &&
        /^\/api\/workspaces\/[^/]+\/replicas\/[^/]+\/github-write\/(inspect|abandon)$/.test(path);
      if (req.method !== 'GET' && !bearer(req))
        assert(req.headers.origin === origin, 403, '请求来源不匹配');
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (path === '/api/me' && req.method === 'GET') {
        let owner: string | null = null;
        try {
          owner = store.owner(cookie(req));
        } catch {}
        return json(res, 200, {
          owner,
          needsSetup: !store.hasAccount(),
          localOnly: options.localOnly === true,
        });
      }
      if ((path === '/api/login' || path === '/api/setup') && req.method === 'POST') {
        const key = req.socket.remoteAddress ?? 'unknown',
          limit = failures.get(key);
        assert(
          !limit || limit.until <= store.now() || limit.count < 10,
          429,
          '尝试过多，请稍后重试',
        );
        const b = authBody.parse(await body(req));
        try {
          if (path === '/api/setup')
            assert(b.setupToken === options.setupToken, 403, '初始化口令不正确');
          const secret =
            path === '/api/setup'
              ? await store.setup(b.email, b.password)
              : await store.login(b.email, b.password);
          failures.delete(key);
          res.setHeader('Set-Cookie', loginCookie(secret));
          return json(res, 200, { ok: true });
        } catch (e) {
          const current =
            limit && limit.until > store.now() ? limit : { count: 0, until: store.now() + 60000 };
          current.count++;
          failures.set(key, current);
          throw e;
        }
      }
      if (path === '/api/pair/redeem' && req.method === 'POST') {
        // Pairing is a bearer capability. A bridge has no browser cookie or Origin.
        const b = z
          .object({ code: z.string().min(12).max(100), name: z.string().min(1).max(100) })
          .parse(await body(req));
        assert(bearer(req) === b.code, 401, '需要设备配对凭据');
        return json(res, 200, store.redeem(b.code, b.name));
      }
      const owner = path.startsWith('/api/') ? store.owner(cookie(req)) : null;
      if (path === '/api/logout' && req.method === 'POST') {
        const secret = cookie(req);
        store.db.exec('SAVEPOINT moor_logout');
        try {
          notifications.revokeLogin(loginHash(secret));
          store.logout(secret);
          store.db.exec('RELEASE moor_logout');
        } catch (error) {
          store.db.exec('ROLLBACK TO moor_logout; RELEASE moor_logout');
          throw error;
        }
        for (const [ws, v] of viewers) if (v.secret === secret) ws.close(1000, 'logout');
        res.setHeader('Set-Cookie', 'personal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/notifications' && req.method === 'GET')
        return json(res, 200, notifications.state(owner!, loginHash(cookie(req))));
      if (path === '/api/notifications/subscriptions' && req.method === 'POST') {
        const input = pushSubscriptionRequestSchema.parse(await body(req, 8192));
        assert(input.expectedOwner === owner, 409, '通知设置所属账号已变化');
        return json(res, 200, notifications.subscribe(owner!, loginHash(cookie(req)), input));
      }
      const subscriptionPath =
        /^\/api\/notifications\/subscriptions\/([A-Za-z0-9_:-]+)\/(preferences|remove)$/.exec(path);
      if (subscriptionPath && req.method === 'POST') {
        const input = z
          .object({
            notificationVersion: z.literal(1),
            expectedOwner: z.string(),
            ...(subscriptionPath[2] === 'preferences'
              ? { preferences: notificationPreferencesSchema }
              : {}),
          })
          .strict()
          .parse(await body(req, 4096));
        assert(input.expectedOwner === owner, 409, '通知设置所属账号已变化');
        return json(
          res,
          200,
          subscriptionPath[2] === 'remove'
            ? notifications.remove(owner!, loginHash(cookie(req)), subscriptionPath[1])
            : notifications.update(
                owner!,
                loginHash(cookie(req)),
                subscriptionPath[1],
                input.preferences,
              ),
        );
      }
      if (path === '/api/pair' && req.method === 'POST') {
        const input = z.object({ workspaceId: z.string().optional() }).parse(await body(req));
        return json(res, 200, { code: store.pair(owner!, input.workspaceId), expiresIn: 300 });
      }
      if (path === '/api/devices' && req.method === 'GET')
        return json(
          res,
          200,
          store.devices(owner!).map((d: any) => ({
            id: d.id,
            name: d.name,
            online: online(d.id),
            workspaces: bridges.get(d.id)?.workspaces ?? [],
          })),
        );
      const parts = path.split('/').filter(Boolean);
      if (path === '/api/workspaces') {
        if (req.method === 'GET')
          return json(
            res,
            200,
            store.catalog.list(owner!, (id) => (online(id) ? bridges.get(id)!.workspaces : [])),
          );
        if (req.method === 'POST') {
          const input = workspaceInputSchema.parse(await body(req));
          const workspace = store.catalog.create(owner!, input.name);
          changed(owner!, '');
          return json(res, 200, workspace);
        }
      }
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2]) {
        const workspaceId = parts[2];
        store.catalog.workspace(owner!, workspaceId);
        if (parts[3] === 'rename' && req.method === 'POST') {
          const input = workspaceInputSchema.parse(await body(req));
          store.catalog.rename(owner!, workspaceId, input.name);
          changed(owner!, '');
          return json(res, 200, { ok: true });
        }
        if (parts[3] === 'projects' && parts.length === 4 && req.method === 'POST') {
          const input = projectInputSchema.parse(await body(req));
          const project = store.catalog.createProject(
            owner!,
            workspaceId,
            input.name,
            input.source,
          );
          changed(owner!, '');
          return json(res, 200, project);
        }
        if (parts[3] === 'hosts' && parts[4]) {
          const host = store.catalog.binding(owner!, workspaceId, parts[4]);
          if (parts[5] === 'move' && req.method === 'POST') {
            const input = z.object({ workspaceId: z.string() }).parse(await body(req));
            store.catalog.moveHost(owner!, workspaceId, host.id, input.workspaceId);
            for (const [socket, viewer] of viewers)
              if (
                viewer.owner === owner &&
                viewer.watch?.deviceId === host.device_id &&
                viewer.watch.workspaceId === host.runtime_id
              )
                unwatch(socket);
            changed(owner!, host.device_id);
            return json(res, 200, { ok: true });
          }
          if (parts[5] === 'sessions' && req.method === 'GET') {
            assert(
              bridges.get(host.device_id)?.workspaces.some((w) => w.id === host.runtime_id),
              409,
              '本地主机工作区不可用',
            );
            return json(res, 200, await request(host.device_id, 'sessions', host.runtime_id, {}));
          }
        }
        if (parts[3] === 'replicas' && parts[4]) {
          const replica = store.catalog.replica(owner!, workspaceId, parts[4]),
            host = replica.host;
          if (parts[5] === 'assign' && req.method === 'POST') {
            const input = replicaAssignmentSchema.parse(await body(req));
            store.catalog.assign(owner!, workspaceId, replica.id, input.projectId);
            changed(owner!, host.device_id);
            return json(res, 200, { ok: true });
          }
          const runtime = bridges
            .get(host.device_id)
            ?.workspaces.find((w) => w.id === host.runtime_id);
          assert(
            runtime?.projects.some((p) => p.id === replica.local_id),
            409,
            '项目副本离线或已从主机移除',
          );
          if (
            parts[5] === 'github-write' &&
            ['read', 'action', 'inspect', 'abandon'].includes(parts[6] ?? '') &&
            parts.length === 7 &&
            req.method === 'POST'
          ) {
            const kind = parts[6]!,
              value = await body(req, kind === 'read' ? 3 * 1024 * 1024 : 256 * 1024);
            const readInput = kind === 'read' ? githubWriteReadSchema.parse(value) : undefined;
            const inspected =
              kind === 'inspect' ? githubWriteInspectSchema.parse(value) : undefined;
            const abandoned =
              kind === 'abandon' ? githubWriteAbandonSchema.parse(value) : undefined;
            const actionInput =
              kind === 'action'
                ? githubWriteActionSchema.parse(value)
                : (inspected?.request ?? abandoned?.request);
            const input = readInput ?? actionInput!;
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              'GitHub 写入请求与项目副本不匹配',
            );
            assert(runtime, 409, '执行电脑暂时不可用');
            assert(
              runtime.features?.includes(GITHUB_WRITE_FEATURE),
              409,
              '请先升级执行电脑上的 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            const current = () => {
              assert(store.owner(cookie(req)) === owner, 401, '请先登录');
              store.device(owner!, host.device_id);
              const r = store.catalog.replica(owner!, workspaceId, replica.id);
              const w = bridges
                .get(host.device_id)
                ?.workspaces.find((w) => w.id === input.workspaceId);
              assert(
                r.host.device_id === host.device_id &&
                  r.host.runtime_id === input.workspaceId &&
                  r.local_id === input.localProjectId &&
                  r.project_id === replica.project_id &&
                  online(host.device_id) &&
                  bridges.get(host.device_id)?.socket === requestSocket &&
                  w?.userId === runtime.userId &&
                  w?.machineId === runtime.machineId &&
                  w.features?.includes(GITHUB_WRITE_FEATURE) &&
                  w.projects.some((p) => p.id === input.localProjectId),
                409,
                'GitHub 写入请求的执行范围已变化，请重新读取',
              );
            };
            current();
            scopedActionDispatched = kind === 'action';
            let raw: unknown, failed: { error: unknown } | undefined;
            try {
              raw = await request(
                host.device_id,
                'github-write-' + kind,
                host.runtime_id,
                readInput ?? inspected ?? abandoned ?? actionInput,
                replica.local_id,
              );
            } catch (error) {
              failed = { error };
            }
            current();
            if (failed) throw failed.error;
            if (readInput) {
              const parsed = githubWriteReadResultSchema.safeParse(raw);
              assert(parsed.success, 502, '执行电脑返回的 GitHub 写入预览不可验证');
              const result = parsed.data;
              assert(
                Buffer.byteLength(JSON.stringify(result)) <= 3 * 1024 * 1024,
                502,
                'GitHub 写入预览超过限制',
              );
              assert(
                result.workspaceId === input.workspaceId &&
                  result.localProjectId === input.localProjectId &&
                  result.sessionId === input.sessionId &&
                  result.view === readInput.view,
                502,
                'GitHub 写入预览范围不匹配',
              );
              if ('repositoryId' in readInput)
                assert(
                  'repository' in result &&
                    result.repository?.id === readInput.repositoryId &&
                    result.configVersion === readInput.configVersion,
                  502,
                  'GitHub 仓库或授权版本不匹配',
                );
              if ('page' in readInput)
                assert(
                  'result' in result && result.result.page === readInput.page,
                  502,
                  'GitHub 写入分页不匹配',
                );
              if (readInput.view === 'files' || readInput.view === 'review-comments')
                assert(
                  'number' in result &&
                    result.number === readInput.number &&
                    result.headSha === readInput.headSha &&
                    result.baseSha === readInput.baseSha,
                  502,
                  'GitHub 审阅预览不属于当前 PR 提交',
                );
              if (readInput.view === 'push-preview')
                assert(
                  result.view === 'push-preview' &&
                    result.branch === readInput.branch &&
                    result.headOid === readInput.headOid,
                  502,
                  'GitHub 推送预览不属于所选本地分支',
                );
              if (readInput.view === 'commit-preview')
                assert(
                  result.view === 'commit-preview' &&
                    result.files.length === readInput.paths.length &&
                    new Set(result.files.map((file) => file.path)).size === result.files.length &&
                    result.files.every((file) => readInput.paths.includes(file.path)),
                  502,
                  'Git 提交预览包含未选择的文件',
                );
              return json(res, 200, result);
            }
            const parsed = githubWriteReceiptSchema.safeParse(raw);
            assert(parsed.success, 502, '执行电脑返回的 GitHub 写入回执不可验证');
            const result = parsed.data;
            assert(
              Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024,
              502,
              'GitHub 写入回执超过限制',
            );
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId &&
                result.operationId === actionInput!.operationId &&
                result.action === actionInput!.action &&
                result.requestVersion ===
                  'sha256:' +
                    createHash('sha256').update(JSON.stringify(actionInput!)).digest('hex'),
              502,
              'GitHub 写入回执不属于原操作',
            );
            if ('number' in actionInput! && result.result?.number !== undefined)
              assert(result.result.number === actionInput.number, 502, 'GitHub 写入回执编号不匹配');
            if (actionInput!.action === 'push' && result.result?.sha !== undefined)
              assert(result.result.sha === actionInput!.headOid, 502, 'GitHub 推送回执提交不匹配');
            return json(res, 200, result);
          }
          if (
            parts[5] === 'github' &&
            ['read', 'action', 'abandon'].includes(parts[6] ?? '') &&
            parts.length === 7 &&
            req.method === 'POST'
          ) {
            const action = parts[6] !== 'read',
              value = await body(req, 16 * 1024);
            const actionInput = action ? githubActionSchema.parse(value) : undefined;
            const readInput = action ? undefined : githubReadSchema.parse(value);
            const input = actionInput ?? readInput!;
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              'GitHub 请求与项目副本不匹配',
            );
            assert(runtime, 409, '执行电脑暂时不可用');
            assert(runtime.features?.includes(GITHUB_FEATURE), 409, '请先升级执行电脑上的 Moor');
            const requestSocket = bridges.get(host.device_id)?.socket;
            const current = () => {
              assert(store.owner(cookie(req)) === owner, 401, '请先登录');
              store.device(owner!, host.device_id);
              const r = store.catalog.replica(owner!, workspaceId, replica.id);
              const w = bridges
                .get(host.device_id)
                ?.workspaces.find((w) => w.id === input.workspaceId);
              assert(
                r.host.device_id === host.device_id &&
                  r.host.runtime_id === input.workspaceId &&
                  r.local_id === input.localProjectId &&
                  online(host.device_id) &&
                  bridges.get(host.device_id)?.socket === requestSocket &&
                  w?.userId === runtime.userId &&
                  w?.machineId === runtime.machineId &&
                  w.features?.includes(GITHUB_FEATURE) &&
                  w.projects.some((p) => p.id === input.localProjectId),
                409,
                'GitHub 请求的执行范围已变化，请重新读取',
              );
            };
            current();
            scopedActionDispatched = action;
            let raw: unknown, failed: { error: unknown } | undefined;
            try {
              raw = await request(
                host.device_id,
                'github-' + parts[6],
                host.runtime_id,
                input,
                replica.local_id,
              );
            } catch (error) {
              failed = { error };
            }
            current();
            if (failed) throw failed.error;
            const parsed = action
              ? githubReceiptSchema.safeParse(raw)
              : githubReadResultSchema.safeParse(raw);
            assert(parsed.success, 502, '执行电脑返回的 GitHub 内容不可验证');
            const result = parsed.data;
            assert(
              Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024,
              502,
              'GitHub 内容超过限制',
            );
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId,
              502,
              'GitHub 响应范围不匹配',
            );
            if (actionInput) {
              assert(
                'operationId' in result &&
                  result.operationId === actionInput.operationId &&
                  result.binding.revision ===
                    actionInput.expectedRevision +
                      ('abandoned' in result && result.abandoned ? 0 : 1),
                502,
                'GitHub 绑定确认不属于原操作',
              );
              if ('abandoned' in result && result.abandoned) {
                assert(!result.binding.context, 502, '未执行确认不能包含 GitHub 上下文');
              } else if (actionInput.action === 'unbind')
                assert(
                  !result.binding.context && !('redacted' in result && result.redacted),
                  502,
                  'GitHub 解绑尚未确认',
                );
              else if (!('redacted' in result && result.redacted))
                assert(
                  result.binding.context?.repository.id === actionInput.repositoryId &&
                    result.binding.context.branch === actionInput.branch &&
                    JSON.stringify(result.binding.context.subject) ===
                      JSON.stringify(actionInput.subject),
                  502,
                  'GitHub 绑定确认与所选上下文不匹配',
                );
            } else {
              assert(
                'view' in result && result.view === readInput!.view,
                502,
                'GitHub 响应类型不匹配',
              );
              if (readInput!.view !== 'overview')
                assert(
                  'repository' in result &&
                    result.repository?.id === readInput!.repositoryId &&
                    result.configVersion === readInput!.configVersion,
                  502,
                  'GitHub 仓库或授权版本不匹配',
                );
              if ('page' in readInput!) {
                assert(
                  ('result' in result && result.result.page === readInput!.page) ||
                    ('checks' in result &&
                      result.checks.page === readInput!.page &&
                      result.statuses.page === readInput!.page),
                  502,
                  'GitHub 分页响应不匹配',
                );
              }
              if (readInput!.view === 'issues' || readInput!.view === 'pulls')
                assert(
                  'state' in result &&
                    result.state === readInput!.state &&
                    'result' in result &&
                    result.result.items.every(
                      (item) =>
                        'kind' in item &&
                        item.kind === (readInput!.view === 'issues' ? 'issue' : 'pull'),
                    ),
                  502,
                  'GitHub 列表类型或筛选状态不匹配',
                );
              if (readInput!.view === 'issue' || readInput!.view === 'pull') {
                assert(
                  'item' in result && result.item.number === readInput!.number,
                  502,
                  'GitHub 上下文编号不匹配',
                );
                if ('item' in result && result.item.kind === 'pull')
                  assert(
                    result.item.base.repository.id === result.repository.id,
                    502,
                    'PR 不属于已登记仓库',
                  );
              }
              if (readInput!.view === 'comments')
                assert(
                  'subject' in result &&
                    result.subject === readInput!.subject &&
                    result.number === readInput!.number,
                  502,
                  'GitHub 评论范围不匹配',
                );
              if (readInput!.view === 'checks')
                assert(
                  'checks' in result &&
                    result.number === readInput!.number &&
                    result.headSha === readInput!.headSha,
                  502,
                  'CI 不属于当前 PR 提交',
                );
            }
            return json(res, 200, result);
          }
          if (
            parts[5] === 'fork' &&
            ['options', 'action'].includes(parts[6] ?? '') &&
            parts.length === 7 &&
            req.method === 'POST'
          ) {
            assert(runtime, 409, '执行主机不可用');
            const action = parts[6] === 'action';
            const value = await body(req, 16 * 1024);
            const actionInput = action ? sessionForkSchema.parse(value) : undefined;
            const input = actionInput ?? forkOptionsReadSchema.parse(value);
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              'Fork 请求与项目副本不匹配',
            );
            assert(
              runtime.features?.includes(SESSION_FORK_FEATURE),
              409,
              '请先升级执行电脑上的 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            // Authentication can expire while the request body is being read.
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            store.device(owner!, host.device_id);
            const dispatchReplica = store.catalog.replica(owner!, workspaceId, replica.id);
            const dispatchRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              dispatchReplica.host.device_id === host.device_id &&
                dispatchReplica.host.runtime_id === input.workspaceId &&
                dispatchReplica.local_id === input.localProjectId &&
                dispatchRuntime?.userId === runtime.userId &&
                dispatchRuntime?.machineId === runtime.machineId &&
                dispatchRuntime.features?.includes(SESSION_FORK_FEATURE) &&
                dispatchRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              'Fork 请求的执行范围已变化',
            );
            scopedActionDispatched = action;
            let raw: unknown, rpcError: { cause: unknown } | undefined;
            try {
              raw = await request(
                host.device_id,
                action ? 'fork-action' : 'fork-options',
                host.runtime_id,
                input,
                replica.local_id,
              );
            } catch (cause) {
              rpcError = { cause };
            }
            // A lost receipt after native Fork started is never proof of rejection.
            // Host errors may also contain private data: reauthorize both outcomes.
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            store.device(owner!, host.device_id);
            const currentReplica = store.catalog.replica(owner!, workspaceId, replica.id);
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              currentReplica.host.device_id === host.device_id &&
                currentReplica.host.runtime_id === input.workspaceId &&
                currentReplica.local_id === input.localProjectId &&
                online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.userId === runtime.userId &&
                currentRuntime?.machineId === runtime.machineId &&
                currentRuntime.features?.includes(SESSION_FORK_FEATURE) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              'Fork 请求的执行目标已变化，请手动确认原操作',
            );
            if (rpcError) throw rpcError.cause;
            const parsed = action
              ? forkReceiptSchema.safeParse(raw)
              : forkOptionsResultSchema.safeParse(raw);
            assert(parsed.success, 502, '执行主机返回的 Fork 结果格式无效');
            const result = parsed.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId &&
                Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024,
              502,
              '执行主机返回的 Fork 结果与请求不匹配',
            );
            if (actionInput) {
              assert(
                'operationId' in result &&
                  result.operationId === actionInput.operationId &&
                  result.childSessionId === actionInput.childSessionId,
                502,
                'Fork 操作或子会话确认不匹配',
              );
              if (result.origin) {
                assert(
                  result.origin.sourceSessionId === actionInput.sessionId &&
                    result.origin.sourceVersion === actionInput.expectedSourceVersion &&
                    JSON.stringify(result.origin.cutoff) === JSON.stringify(actionInput.cutoff) &&
                    result.origin.directory === actionInput.directory.kind,
                  502,
                  'Fork 来源或历史截止点不匹配',
                );
              }
              if (result.phase === 'accepted') {
                const execution = result.execution!;
                assert(
                  actionInput.directory.kind === 'worktree'
                    ? execution.mode === 'worktree' &&
                        execution.revision === 1 &&
                        execution.branch === actionInput.directory.newBranch &&
                        execution.baseOid === actionInput.directory.expectedOid &&
                        result.origin?.branch === actionInput.directory.newBranch &&
                        result.origin?.baseOid === actionInput.directory.expectedOid
                    : execution.revision === actionInput.expectedExecutionRevision &&
                        execution.mode ===
                          (actionInput.expectedExecutionRevision === 0 ? 'shared' : 'worktree'),
                  502,
                  'Fork 确认的工作目录与原请求不匹配',
                );
              }
            } else if ('turnId' in input && input.turnId) {
              assert(
                'turns' in result &&
                  result.turns.length === 1 &&
                  result.turns[0]?.turnId === input.turnId,
                502,
                'Fork 选项不属于所选回合',
              );
            }
            return json(res, 200, result);
          }
          if (
            parts[5] === 'git' &&
            ['state', 'action'].includes(parts[6] ?? '') &&
            parts.length === 7 &&
            req.method === 'POST'
          ) {
            const action = parts[6] === 'action';
            try {
              assert(runtime, 409, '执行主机不可用');
              const value = await body(req, 16 * 1024);
              const actionInput = action ? gitActionSchema.parse(value) : undefined;
              const input = actionInput ?? gitStateReadSchema.parse(value);
              assert(
                input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
                400,
                'Git 请求与项目副本不匹配',
              );
              assert(
                runtime.features?.includes(GIT_WORKTREE_FEATURE),
                409,
                '请先升级执行电脑上的 Moor',
              );
              const requestSocket = bridges.get(host.device_id)?.socket;
              // Reading even a small request body yields. Recheck authorization
              // before starting a filesystem operation, as well as on its reply.
              assert(store.owner(cookie(req)) === owner, 401, '请先登录');
              store.device(owner!, host.device_id);
              const dispatchReplica = store.catalog.replica(owner!, workspaceId, replica.id);
              const dispatchRuntime = bridges
                .get(host.device_id)
                ?.workspaces.find((w) => w.id === input.workspaceId);
              assert(
                dispatchReplica.host.device_id === host.device_id &&
                  dispatchReplica.host.runtime_id === input.workspaceId &&
                  dispatchReplica.local_id === input.localProjectId &&
                  dispatchRuntime?.userId === runtime.userId &&
                  dispatchRuntime?.machineId === runtime.machineId &&
                  dispatchRuntime?.features?.includes(GIT_WORKTREE_FEATURE) &&
                  dispatchRuntime.projects.some((p) => p.id === input.localProjectId),
                409,
                'Git 请求的执行范围已变化',
              );
              scopedActionDispatched = action;
              let raw: unknown, rpcError: { cause: unknown } | undefined;
              try {
                raw = await request(
                  host.device_id,
                  action ? 'git-action' : 'git-state',
                  host.runtime_id,
                  input,
                  replica.local_id,
                );
              } catch (cause) {
                rpcError = { cause };
              }
              // A Git operation can finish after logout or regrouping. Returning
              // no receipt here must never be interpreted as "Git did not run".
              // Apply the same scope checks before exposing an RPC error message.
              assert(store.owner(cookie(req)) === owner, 401, '请先登录');
              store.device(owner!, host.device_id);
              const current = store.catalog.replica(owner!, workspaceId, replica.id);
              const currentRuntime = bridges
                .get(host.device_id)
                ?.workspaces.find((w) => w.id === host.runtime_id);
              assert(
                current.host.device_id === host.device_id &&
                  current.host.runtime_id === input.workspaceId &&
                  current.local_id === input.localProjectId &&
                  online(host.device_id) &&
                  bridges.get(host.device_id)?.socket === requestSocket &&
                  currentRuntime?.userId === runtime.userId &&
                  currentRuntime?.machineId === runtime.machineId &&
                  currentRuntime?.features?.includes(GIT_WORKTREE_FEATURE) &&
                  currentRuntime.projects.some((p) => p.id === input.localProjectId),
                409,
                'Git 请求的执行目标已变化，请手动确认原操作',
              );
              if (rpcError) throw rpcError.cause;
              const parsed = action
                ? gitActionReceiptSchema.safeParse(raw)
                : gitStateResultSchema.safeParse(raw);
              assert(parsed.success, 502, '执行主机返回的 Git 结果格式无效');
              const result = parsed.data;
              assert(
                result.workspaceId === input.workspaceId &&
                  result.localProjectId === input.localProjectId &&
                  result.sessionId === input.sessionId &&
                  Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024,
                502,
                '执行主机返回的 Git 结果与请求不匹配',
              );
              if (actionInput) {
                assert(
                  'operationId' in result && result.operationId === actionInput.operationId,
                  502,
                  'Git 操作确认编号不匹配',
                );
                if (result.phase === 'accepted') {
                  assert(
                    result.execution.revision === actionInput.expectedRevision + 1 &&
                      result.execution.mode === 'worktree',
                    502,
                    'Git 操作确认版本不匹配',
                  );
                  assert(
                    actionInput.action === 'prepare'
                      ? result.execution.status === 'ready' &&
                          result.execution.branch === actionInput.newBranch &&
                          result.execution.baseOid === actionInput.expectedOid
                      : result.execution.status === 'removed' &&
                          result.execution.executionId === actionInput.executionId &&
                          (actionInput.action === 'detach'
                            ? result.execution.disposition === 'detached'
                            : result.execution.disposition !== 'detached'),
                    502,
                    'Git 操作确认目标不匹配',
                  );
                }
              }
              return json(res, 200, result);
            } catch (error) {
              if (action && !scopedActionDispatched) {
                if (error instanceof AppError)
                  throw new AppError(error.status, error.message, true);
                if (error instanceof z.ZodError) throw new AppError(400, 'Git 操作参数无效', true);
              }
              throw error;
            }
          }
          if (parts[5] === 'agent-options' && req.method === 'POST') {
            const input = z
              .object({ agentId: z.string().min(1).max(160) })
              .strict()
              .parse(await body(req));
            assert(
              runtime?.agents.some((a) => a.id === input.agentId),
              404,
              'Agent 配置不可用',
            );
            return json(
              res,
              200,
              await request(
                host.device_id,
                'agent-options',
                host.runtime_id,
                input,
                replica.local_id,
              ),
            );
          }
          if (parts[5] === 'sessions' && req.method === 'GET')
            return json(
              res,
              200,
              parts[6]
                ? await request(
                    host.device_id,
                    'session',
                    host.runtime_id,
                    { sessionId: parts[6], version: url.searchParams.get('version') ?? undefined },
                    replica.local_id,
                  )
                : await request(host.device_id, 'sessions', host.runtime_id, {}, replica.local_id),
            );
          if (parts[5] === 'mutations' && req.method === 'POST') {
            const mutation = mutationSchema.parse(await body(req));
            assert(mutation.workspaceId === host.runtime_id, 400, '本地工作区不匹配');
            return json(
              res,
              200,
              await request(host.device_id, 'mutate', host.runtime_id, mutation, replica.local_id),
            );
          }
          if (parts[5] === 'session-actions' && parts.length === 6 && req.method === 'POST') {
            const action = sessionActionSchema.parse(await body(req));
            assert(
              action.workspaceId === host.runtime_id && action.localProjectId === replica.local_id,
              400,
              '会话操作与项目副本不匹配',
            );
            assert(
              runtime?.features?.includes('session-actions'),
              409,
              '请先升级执行电脑上的 Moor',
            );
            return json(
              res,
              200,
              await request(
                host.device_id,
                'session-action',
                host.runtime_id,
                action,
                replica.local_id,
              ),
            );
          }
          if (parts[5] === 'file-content' && parts.length === 6 && req.method === 'POST') {
            const input = projectFileReadSchema.parse(await body(req, 16 * 1024));
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              '文件请求与项目副本不匹配',
            );
            assert(
              runtime?.features?.includes(FILE_CONTENT_FEATURE),
              409,
              '请先升级执行电脑上的 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            const response = projectFileResultSchema.safeParse(
              await request(
                host.device_id,
                'file-content',
                host.runtime_id,
                input,
                replica.local_id,
              ),
            );
            // Reads can remain in flight while the user moves a host or signs
            // out. Recheck the original delivery scope before returning bytes.
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            const current = store.catalog.replica(owner!, workspaceId, replica.id);
            assert(
              current.host.device_id === host.device_id &&
                current.host.runtime_id === input.workspaceId &&
                current.local_id === input.localProjectId,
              409,
              '文件请求的执行目标已变更',
            );
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === host.runtime_id);
            assert(
              online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.features?.includes(FILE_CONTENT_FEATURE) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              '项目副本离线或已从主机移除',
            );
            assert(response.success, 502, '执行主机返回的文件内容格式无效');
            const result = response.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId &&
                result.path === input.path &&
                (result.status !== 'not-modified' || input.knownVersion === result.content.version),
              502,
              '执行主机返回的文件内容与请求不匹配',
            );
            return json(res, 200, result);
          }
          if (
            req.method === 'POST' &&
            ((parts[5] === 'attachment-actions' && parts.length === 6) ||
              (parts[5] === 'attachments' && parts[6] === 'read' && parts.length === 7))
          ) {
            const action = parts[5] === 'attachment-actions';
            const input = action
              ? attachmentActionSchema.parse(await body(req, 12 * 1024 * 1024))
              : attachmentReadSchema.parse(await body(req, 16 * 1024));
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              '附件请求与项目副本不匹配',
            );
            assert(
              runtime?.features?.includes(ATTACHMENTS_FEATURE),
              409,
              '请先升级执行电脑上的 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            const raw = await request(
              host.device_id,
              action ? 'attachment-action' : 'read-attachment',
              host.runtime_id,
              input,
              replica.local_id,
            );
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            const current = store.catalog.replica(owner!, workspaceId, replica.id);
            assert(
              current.host.device_id === host.device_id &&
                current.host.runtime_id === input.workspaceId &&
                current.local_id === input.localProjectId,
              409,
              '附件请求的执行目标已变更',
            );
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.features?.includes(ATTACHMENTS_FEATURE) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              '执行主机已不可达，请手动确认附件',
            );
            const parsed = action
              ? attachmentReceiptSchema.safeParse(raw)
              : attachmentContentSchema.safeParse(raw);
            assert(parsed.success, 502, '执行主机返回的附件确认无效');
            const result = parsed.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId,
              502,
              '附件响应与请求范围不匹配',
            );
            if ('action' in input) {
              assert(
                'operationId' in result && result.operationId === input.operationId,
                502,
                '附件响应的操作编号不匹配',
              );
              if (input.action === 'upload')
                assert(
                  isDeepStrictEqual(result.attachment, input.attachment),
                  502,
                  '附件确认与上传内容不匹配',
                );
              else assert('removed' in result && result.removed === true, 502, '附件移除尚未确认');
            } else
              assert(
                result.attachment?.attachmentId === input.attachmentId,
                502,
                '附件响应与请求不匹配',
              );
            return json(res, 200, result);
          }
          if (
            req.method === 'POST' &&
            parts.length === 6 &&
            ['project-tree', 'turn-diff', 'diff-file'].includes(parts[5]!)
          ) {
            const route = parts[5]!;
            const feature = route === 'project-tree' ? PROJECT_TREE_FEATURE : PROJECT_DIFF_FEATURE;
            const payload = await body(req, 16 * 1024);
            const input =
              route === 'project-tree'
                ? projectTreeReadSchema.parse(payload)
                : route === 'turn-diff'
                  ? projectTurnDiffReadSchema.parse(payload)
                  : projectDiffFileReadSchema.parse(payload);
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              '文件请求与项目副本不匹配',
            );
            assert(runtime?.features?.includes(feature), 409, '请先升级执行电脑上的 Moor');
            const requestSocket = bridges.get(host.device_id)?.socket;
            const method =
              route === 'project-tree'
                ? 'read-project-tree'
                : route === 'turn-diff'
                  ? 'read-turn-diff'
                  : 'read-diff-file';
            const raw = await request(
              host.device_id,
              method,
              host.runtime_id,
              input,
              replica.local_id,
            );
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            const current = store.catalog.replica(owner!, workspaceId, replica.id);
            assert(
              current.host.device_id === host.device_id &&
                current.host.runtime_id === input.workspaceId &&
                current.local_id === input.localProjectId,
              409,
              '文件请求的执行目标已变更',
            );
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.features?.includes(feature) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              '执行主机已不可达，请重新读取文件',
            );
            const parsed =
              route === 'project-tree'
                ? projectTreeResultSchema.safeParse(raw)
                : route === 'turn-diff'
                  ? projectTurnDiffResultSchema.safeParse(raw)
                  : projectDiffFileResultSchema.safeParse(raw);
            assert(parsed.success, 502, '执行主机返回的文件内容格式无效');
            const result = parsed.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId,
              502,
              '文件响应与请求范围不匹配',
            );
            if ('turnId' in input) {
              assert(
                'turnId' in result && result.turnId === input.turnId,
                502,
                '变更响应不属于请求的回合',
              );
              if (result.reference)
                assert(result.reference.turnId === input.turnId, 502, '变更引用不属于请求的回合');
              if ('path' in input) {
                const fileInput = projectDiffFileReadSchema.parse(input);
                assert(
                  'path' in result && result.path === input.path,
                  502,
                  '变更响应不属于请求的文件',
                );
                assert(
                  !fileInput.knownVersion || result.reference.version === fileInput.knownVersion,
                  502,
                  '变更响应不属于请求的历史版本',
                );
              }
            } else {
              assert(
                'entries' in result &&
                  result.offset === (input.offset ?? 0) &&
                  result.entries.length <= (input.limit ?? 200),
                502,
                '文件树分页与请求不匹配',
              );
              assert(
                !input.knownVersion || result.version === input.knownVersion,
                502,
                '文件树版本与请求不匹配',
              );
            }
            return json(res, 200, result);
          }
          if (
            req.method === 'POST' &&
            parts.length === 6 &&
            ['question-answers', 'steer'].includes(parts[5]!)
          ) {
            const question = parts[5] === 'question-answers';
            const feature = question ? QUESTIONS_FEATURE : STEER_FEATURE;
            const input = question
              ? questionAnswerSchema.parse(await body(req, 2 * 1024 * 1024))
              : steerRequestSchema.parse(await body(req, 128 * 1024));
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              '交互请求与项目副本不匹配',
            );
            assert(
              runtime?.features?.includes(feature),
              409,
              '执行电脑尚未支持此交互，请更新 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            const raw = await request(
              host.device_id,
              question ? 'answer-question' : 'steer',
              host.runtime_id,
              input,
              replica.local_id,
            );
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            const current = store.catalog.replica(owner!, workspaceId, replica.id);
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              current.host.device_id === host.device_id &&
                current.host.runtime_id === input.workspaceId &&
                current.local_id === input.localProjectId &&
                online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.features?.includes(feature) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              '交互执行目标已变化，结果待主机确认',
            );
            const parsed = question
              ? questionReceiptSchema.safeParse(raw)
              : steerReceiptSchema.safeParse(raw);
            assert(parsed.success, 502, '主机尚未返回有效的交互确认');
            const result = parsed.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId &&
                result.expectedTurnId === input.expectedTurnId &&
                result.operationId === input.operationId,
              502,
              '交互确认与原请求不匹配',
            );
            if ('requestId' in input)
              assert(
                'requestId' in result && result.requestId === input.requestId,
                502,
                '问答确认不属于原请求',
              );
            return json(res, 200, result);
          }
          if (req.method === 'POST' && parts.length === 6 && parts[5] === 'session-search') {
            const input = sessionSearchRequestSchema.parse(await body(req, 8 * 1024));
            assert(
              input.workspaceId === host.runtime_id && input.localProjectId === replica.local_id,
              400,
              '搜索请求与项目副本不匹配',
            );
            assert(
              runtime?.features?.includes(SESSION_SEARCH_FEATURE),
              409,
              '执行电脑尚未支持正文搜索，请更新 Moor',
            );
            const requestSocket = bridges.get(host.device_id)?.socket;
            const raw = await request(
              host.device_id,
              'search-sessions',
              host.runtime_id,
              input,
              replica.local_id,
            );
            assert(store.owner(cookie(req)) === owner, 401, '请先登录');
            const current = store.catalog.replica(owner!, workspaceId, replica.id);
            const currentRuntime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === input.workspaceId);
            assert(
              current.host.device_id === host.device_id &&
                current.host.runtime_id === input.workspaceId &&
                current.local_id === input.localProjectId &&
                online(host.device_id) &&
                bridges.get(host.device_id)?.socket === requestSocket &&
                currentRuntime?.features?.includes(SESSION_SEARCH_FEATURE) &&
                currentRuntime.projects.some((p) => p.id === input.localProjectId),
              409,
              '搜索执行目标已变化，请重新搜索',
            );
            const parsed = sessionSearchResultSchema.safeParse(raw);
            assert(parsed.success, 502, '主机返回的搜索结果格式无效');
            const result = parsed.data;
            assert(
              result.workspaceId === input.workspaceId &&
                result.localProjectId === input.localProjectId &&
                result.sessionId === input.sessionId &&
                result.scope === input.scope &&
                result.query === input.query &&
                result.hits.length <= input.limit,
              502,
              '搜索响应与请求不匹配',
            );
            if (input.scope === 'session')
              assert(
                result.hits.every((hit) => hit.sessionId === input.sessionId),
                502,
                '搜索结果超出当前会话',
              );
            return json(res, 200, result);
          }
          if (parts[5] === 'cancel' && req.method === 'POST') {
            const input = z
              .object({ sessionId: z.string(), turnId: z.string() })
              .parse(await body(req));
            return json(
              res,
              200,
              await request(host.device_id, 'cancel', host.runtime_id, input, replica.local_id),
            );
          }
        }
      }
      if (parts[0] === 'api' && parts[1] === 'devices' && parts[2]) {
        const d = store.device(owner!, parts[2]);
        if (parts[3] === 'revoke' && req.method === 'POST') {
          store.revoke(owner!, d.id);
          rejectFileReads(d.id);
          bridges.get(d.id)?.socket.close(1008, 'revoked');
          bridges.delete(d.id);
          changed(owner!, d.id);
          return json(res, 200, { ok: true });
        }
        assert(online(d.id), 409, '执行电脑不可达，只能查看已有缓存');
        const ws = bridges
          .get(d.id)!
          .workspaces.find((w) => w.id === url.searchParams.get('workspace'));
        assert(ws, 404, '工作区不可用');
        if (parts[3] === 'sessions' && parts.length === 4 && req.method === 'GET')
          return json(res, 200, await request(d.id, 'sessions', ws.id, {}));
        if (parts[3] === 'sessions' && parts[4] && req.method === 'GET')
          return json(
            res,
            200,
            await request(d.id, 'session', ws.id, {
              sessionId: parts[4],
              version: url.searchParams.get('version') ?? undefined,
            }),
          );
        if (parts[3] === 'mutations' && req.method === 'POST') {
          const b = mutationSchema.parse(await body(req));
          assert(ws.id === b.workspaceId, 400, '工作区不匹配');
          return json(res, 200, await request(d.id, 'mutate', ws.id, b));
        }
        if (parts[3] === 'session-actions' && parts.length === 4 && req.method === 'POST') {
          const action = sessionActionSchema.parse(await body(req));
          assert(ws.id === action.workspaceId, 400, '工作区不匹配');
          assert(
            ws.projects.some((project) => project.id === action.localProjectId),
            404,
            '项目副本不可用',
          );
          assert(ws.features?.includes('session-actions'), 409, '请先升级执行电脑上的 Moor');
          return json(
            res,
            200,
            await request(d.id, 'session-action', ws.id, action, action.localProjectId),
          );
        }
        if (parts[3] === 'cancel' && req.method === 'POST') {
          const b = z.object({ sessionId: z.string(), turnId: z.string() }).parse(await body(req));
          return json(res, 200, await request(d.id, 'cancel', ws.id, b));
        }
      }
      assert(req.method === 'GET' && !path.startsWith('/api/'), 404, '未找到');
      const publicDir = resolve(options.publicDir ?? 'dist/public'),
        filename = resolve(publicDir, path === '/' ? 'index.html' : '.' + path);
      assert(filename.startsWith(publicDir + '/'), 404, '未找到');
      await serveStatic(req, res, filename);
    } catch (e) {
      if (!res.headersSent)
        json(res, e instanceof AppError ? e.status : e instanceof z.ZodError ? 400 : 500, {
          error:
            e instanceof AppError
              ? e.message
              : e instanceof z.ZodError
                ? '请求格式无效'
                : '服务暂时不可用',
          rejected:
            !scopedRecoveryRequest &&
            ((scopedActionRequest && !scopedActionDispatched) ||
              (e instanceof AppError && e.rejected)),
        });
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const path = new URL(req.url ?? '/', origin).pathname;
      if (path === '/bridge') {
        const d = store.deviceToken(bearer(req));
        wss.handleUpgrade(req, socket, head, (ws) => {
          const previous = bridges.get(d.id);
          if (previous) rejectFileReads(d.id, previous.socket);
          previous?.socket.close(1008, 'replaced');
          bridges.set(d.id, { socket: ws, ready: false, workspaces: [] });
          ws.on('message', (raw) => {
            try {
              const current = store.deviceToken(bearer(req));
              assert(bridges.get(d.id)?.socket === ws, 409, '连接已替换');
              const message = JSON.parse(raw.toString());
              if (message.type === 'hello') {
                const b = helloSchema.parse(message);
                store.bind(current, b.machineId, b.workspaces);
                bridges.set(d.id, { socket: ws, ready: true, workspaces: b.workspaces });
                changed(d.owner, d.id);
                send(ws, { type: 'ready' });
                for (const v of viewers.values())
                  if (v.watch?.deviceId === d.id) send(ws, { type: 'watch', ...v.watch });
              } else if (message.type === 'unavailable') {
                rejectFileReads(d.id, ws);
                bridges.set(d.id, { socket: ws, ready: false, workspaces: [] });
                changed(d.owner, d.id);
              } else if (message.type === 'changed') {
                changed(d.owner, d.id, message.workspaceId, {
                  scope: 'doc',
                  docId: message.sessionId,
                });
              } else if (message.type === 'github-changed') {
                const event = z
                  .object({
                    type: z.literal('github-changed'),
                    workspaceId: z.string().min(1).max(200),
                  })
                  .strict()
                  .parse(message);
                assert(
                  bridges
                    .get(d.id)
                    ?.workspaces.some(
                      (w) => w.id === event.workspaceId && w.features?.includes(GITHUB_FEATURE),
                    ),
                  409,
                  'GitHub 配置事件范围不匹配',
                );
                for (const [viewer, identity] of viewers) {
                  if (identity.owner !== d.owner) continue;
                  try {
                    assert(store.owner(identity.secret) === d.owner, 401, '请先登录');
                    send(viewer, {
                      type: 'changed',
                      deviceId: d.id,
                      workspaceId: event.workspaceId,
                      room: { scope: 'github' },
                    });
                  } catch {
                    viewer.close(1008, 'login expired');
                  }
                }
              } else if (message.type === 'notification') {
                const event = hostNotificationEventSchema.parse(message.event);
                void deliverNotification(current, ws, event);
              } else if (message.type === 'response') {
                const c = commands.get(message.requestId);
                if (c?.device === d.id && c.socket === ws) {
                  clearTimeout(c.timer);
                  commands.delete(message.requestId);
                  if (message.error)
                    c.reject(
                      new AppError(
                        Number(message.error.status) || 502,
                        String(message.error.message),
                        message.error.rejected === true,
                      ),
                    );
                  else c.resolve(message.result);
                }
              }
            } catch {
              ws.close(1008, 'invalid message');
            }
          });
          ws.on('close', () => {
            rejectFileReads(d.id, ws);
            if (bridges.get(d.id)?.socket === ws) {
              bridges.delete(d.id);
              changed(d.owner, d.id);
              for (const [id, c] of commands)
                if (c.device === d.id) {
                  clearTimeout(c.timer);
                  commands.delete(id);
                  c.reject(new AppError(504, '执行电脑断开，送达结果未知；请重试确认'));
                }
            }
          });
          ws.on('error', () => {});
        });
      } else {
        assert(path === '/events' && req.headers.origin === origin, 403, '请求来源不匹配');
        const secret = cookie(req),
          owner = store.owner(secret);
        wss.handleUpgrade(req, socket, head, (ws) => {
          viewers.set(ws, { owner, secret });
          ws.on('message', (raw) => {
            try {
              assert(raw.toString().length < 4096, 400, '无效订阅');
              store.owner(secret);
              if (JSON.parse(raw.toString()).type === 'unwatch') {
                unwatch(ws);
                return;
              }
              const m = z
                .object({
                  type: z.literal('watch'),
                  deviceId: z.string(),
                  workspaceId: z.string(),
                  sessionId: z.string(),
                  catalogWorkspaceId: z.string().optional(),
                  replicaId: z.string().optional(),
                })
                .parse(JSON.parse(raw.toString()));
              store.device(owner, m.deviceId);
              let localProjectId: string | undefined;
              if (m.catalogWorkspaceId || m.replicaId) {
                assert(m.catalogWorkspaceId && m.replicaId, 400, '订阅执行目标不完整');
                const r = store.catalog.replica(owner, m.catalogWorkspaceId, m.replicaId);
                assert(
                  r.host.device_id === m.deviceId && r.host.runtime_id === m.workspaceId,
                  400,
                  '订阅执行目标不匹配',
                );
                localProjectId = r.local_id;
              }
              unwatch(ws);
              if (m.sessionId) {
                const watch = {
                  deviceId: m.deviceId,
                  workspaceId: m.workspaceId,
                  sessionId: m.sessionId,
                  localProjectId,
                  catalogWorkspaceId: m.catalogWorkspaceId,
                  replicaId: m.replicaId,
                };
                viewers.get(ws)!.watch = watch;
                const b = bridges.get(m.deviceId);
                if (b) send(b.socket, { type: 'watch', ...watch });
              }
            } catch {
              ws.close(1008, 'invalid subscription');
            }
          });
          ws.on('close', () => {
            unwatch(ws);
            viewers.delete(ws);
          });
          ws.on('error', () => {});
        });
      }
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', () => {});
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
    for (const [ws, v] of viewers)
      try {
        store.owner(v.secret);
      } catch {
        ws.close(1008, 'login expired');
      }
  }, 20000);
  heartbeat.unref();
  // noServer sockets do not emit connection automatically; install liveness at upgrade completion.
  const originalUpgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, socket, head, cb) =>
    originalUpgrade(req, socket, head, (ws, r) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      cb(ws, r);
    });
  return {
    server,
    online,
    setOrigin: (value: string) => {
      origin = new URL(value).origin;
    },
    close: async () => {
      closing = true;
      notifications.close();
      clearInterval(heartbeat);
      for (const c of commands.values()) {
        clearTimeout(c.timer);
        c.reject(new AppError(503, '服务关闭'));
      }
      commands.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
