import { hostCommandContracts, matchHostCommandRoute } from '@moor/protocol/host-command-contract';
import { forwardReplicaCommand } from './replica-command';
import { hostCommandSchema } from '@moor/protocol/host-command';
import { validateHostResponse } from '@moor/protocol/host-response';
import { SESSION_PAGE_FEATURE } from '@moor/protocol/session-page';
import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';

import {
  RETIRED_RECORDS_FEATURE,
  RETIRED_SESSION_FEATURE,
  HOST_UPGRADE_REQUIRED,
} from '@moor/protocol/connection-authority';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { serveStatic } from './static';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { Store, hash as loginHash, type Device } from './accounts';
import { createHash } from 'node:crypto';
import { RelayNotifications, type WebPushTransport } from './notifications';
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
} from '@moor/protocol/notification-protocol';
import {
  AppError,
  assert,
  helloSchema,
  id,
  mutationSchema,
  sessionActionSchema,
} from '@moor/protocol/protocol';
import type { RuntimeWorkspace } from '@moor/protocol/protocol';

import { sessionBase64Schema, sessionCancelSchema } from '@moor/protocol/session-responses';
import {
  workspaceInputSchema,
  projectInputSchema,
  replicaAssignmentSchema,
} from '@moor/protocol/catalog';
import {
  workspaceCatalogSnapshotSchema,
  workspaceReplicaContextSchema,
} from '@moor/protocol/workspace-catalog';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  actorKey,
  actorSchema,
  attentionContextSchema,
  attentionContinueSchema,
  attentionContinueInput,
  attentionDispositionSchema,
  attentionListQuerySchema,
  attentionPermissionSchema,
  attentionSeenSchema,
  type AttentionContext,
} from '@moor/protocol/attention';
import {
  COLLABORATION_FEATURE,
  COLLABORATION_LIMITS,
  collaborationContextSchema,
  collaborationKey,
  collaborationMemberSchema,
  collaborationOfferSchema,
  collaborationOfferReceiptSchema,
  collaborationReadResponseSchema,
  collaborationSyncRequestSchema,
  validateCollaborationSyncResponse,
} from '@moor/protocol/collaboration-protocol';

import { GITHUB_FEATURE } from '@moor/protocol/github-protocol';

import { SKILLS_FEATURE } from '@moor/protocol/skills-protocol';

import { MCP_FEATURE } from '@moor/protocol/mcp-protocol';
import { GoogleAuth } from './google-auth';
import type { GoogleOidcProvider } from './google-auth';
export function createApp(
  store: Store,
  options: {
    origin: string;
    setupToken: string;
    publicDir?: string;
    localOnly?: boolean;
    localInstanceId?: string;
    localInstanceProof?: (challenge: string) => string;
    pushTransport?: WebPushTransport;
    validatePushSubscription?: ConstructorParameters<
      typeof RelayNotifications
    >[1]['validateSubscription'];
    googleProvider?: GoogleOidcProvider;
  },
) {
  let origin = new URL(options.origin).origin;
  let attentionOriginGeneration = 0;
  const attentionFeatures = [ATTENTION_FEATURE, ACTOR_FEATURE, FOLLOWUP_FEATURE];
  const actor = (accountId: string) => ({
    kind: options.localOnly ? ('local' as const) : ('relay' as const),
    authorityId: store.authorityId,
    accountId,
  });
  const googleAuth = new GoogleAuth(store, {
    origin,
    setupToken: options.setupToken,
    provider: options.localOnly ? undefined : options.googleProvider,
  });
  const localInstanceId = options.localInstanceId;
  const bridges = new Map<
    string,
    { socket: WebSocket; ready: boolean; attentionReady: boolean; workspaces: RuntimeWorkspace[] }
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
  const connectionVersions = new WeakMap<WebSocket, string>();
  function replicaContext(owner: string, workspaceId: string, replicaId: string) {
    // All database and live-connection reads complete synchronously in one snapshot.
    // The version describes this mapping, not a lease or permission to execute it.
    store.db.exec('SAVEPOINT workspace_replica_context');
    try {
      const replica = store.catalog.replica(owner, workspaceId, replicaId);
      const host = replica.host;
      const device = store.device(owner, host.device_id);
      const connection = bridges.get(host.device_id);
      const runtime = connection?.workspaces.find((value) => value.id === host.runtime_id);
      const project = runtime?.projects.find((value) => value.id === replica.local_id);
      assert(
        online(host.device_id) &&
          connection &&
          runtime &&
          project &&
          device.machine_id === runtime.machineId,
        409,
        '项目副本离线或执行身份已变化',
      );
      let connectionVersion = connectionVersions.get(connection.socket);
      if (!connectionVersion) {
        connectionVersion = crypto.randomUUID();
        connectionVersions.set(connection.socket, connectionVersion);
      }
      const target = {
        owner,
        deviceId: host.device_id,
        userId: runtime.userId,
        machineId: runtime.machineId,
        workspaceId: runtime.id,
        localProjectId: replica.local_id,
        catalogWorkspaceId: workspaceId,
        catalogProjectId: replica.project_id,
        replicaId: replica.id,
      };
      const result = workspaceReplicaContextSchema.parse({
        version: 1,
        identity: { owner, actor: actor(owner) },
        target,
        mappingVersion: createHash('sha256')
          .update(JSON.stringify([target, host.id, project.rootPath, connectionVersion]))
          .digest('hex'),
        runtime: { ...runtime, projects: [project] },
      });
      store.db.exec('RELEASE workspace_replica_context');
      return result;
    } catch (error) {
      store.db.exec('ROLLBACK TO workspace_replica_context; RELEASE workspace_replica_context');
      throw error;
    }
  }
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
    validateSubscription: options.validatePushSubscription,
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
    if (closing) return;
    for (const [ws, v] of viewers)
      if (v.owner === owner) send(ws, { type: 'changed', deviceId, workspaceId, room });
    if (!room || (room as { scope?: string }).scope === 'doc') {
      const members = new Set(
        store.catalog
          .list(owner, () => [])
          .filter((space) =>
            space.hosts.some(
              (host) =>
                host.deviceId === deviceId &&
                (!workspaceId || host.runtimeWorkspaceId === workspaceId),
            ),
          )
          .flatMap((space) => store.catalog.collaborationMembers(space.id)),
      );
      for (const [ws, viewer] of viewers)
        if (members.has(viewer.owner))
          send(ws, { type: 'collaboration-changed', deviceId, workspaceId });
    }
  };
  function rejectFileReads(device: string, socket?: WebSocket) {
    for (const [id, pending] of commands)
      if (
        pending.device === device &&
        (Object.hasOwn(hostCommandContracts, pending.method) ||
          pending.method.startsWith('attention-')) &&
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
    authorityOwner?: string,
    context?: AttentionContext,
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
        ...(authorityOwner ? { authorityOwner } : {}),
        ...(context ? { context } : {}),
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
      const pathParts = path.split('/').filter(Boolean);
      const replicaCommand =
        pathParts[0] === 'api' &&
        pathParts[1] === 'workspaces' &&
        pathParts[2] &&
        pathParts[3] === 'replicas' &&
        pathParts[4]
          ? matchHostCommandRoute(req.method, pathParts.slice(5))
          : undefined;
      scopedActionRequest =
        !!replicaCommand && hostCommandContracts[replicaCommand].delivery === 'action';
      scopedRecoveryRequest =
        !!replicaCommand && hostCommandContracts[replicaCommand].delivery === 'recovery';
      if (path.startsWith('/api/security/trust/')) {
        if (!req.readableEnded && !req.destroyed) req.resume();
        return json(res, 410, { error: '端到端加密与信任分发入口已退场；原数据保持不变。' });
      }
      const instanceHeader = req.headers['x-moor-instance'];
      if (instanceHeader !== undefined)
        assert(
          options.localOnly === true &&
            typeof localInstanceId === 'string' &&
            instanceHeader === localInstanceId,
          409,
          '本机执行服务实例已变化，请重新连接',
        );
      if (path === '/api/local-instance' && req.method === 'GET') {
        assert(
          options.localOnly === true && typeof localInstanceId === 'string' && !closing,
          404,
          '未找到',
        );
        const queries = [...url.searchParams.entries()];
        if (queries.length === 0) return json(res, 200, { instanceId: localInstanceId });
        assert(queries.length === 1 && queries[0]![0] === 'challenge', 400, '本机实例挑战格式无效');
        const challenge = queries[0]![1];
        assert(
          /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
            Buffer.from(challenge, 'base64url').toString('base64url') === challenge,
          400,
          '本机实例挑战格式无效',
        );
        assert(options.localInstanceProof, 404, '本机实例挑战不可用');
        let proof: string;
        try {
          proof = options.localInstanceProof(challenge);
        } catch {
          throw new AppError(404, '本机实例挑战不可用');
        }
        assert(/^[a-f0-9]{64}$/.test(proof), 502, '本机实例证明不可用');
        return json(res, 200, { instanceId: localInstanceId, challenge, proof });
      }
      if (req.method !== 'GET' && !bearer(req))
        assert(req.headers.origin === origin, 403, '请求来源不匹配');
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (await googleAuth.handle(req, res, url)) return;
      if (path === '/api/me' && req.method === 'GET') {
        let owner: string | null = null;
        try {
          owner = store.owner(cookie(req));
        } catch {}
        return json(res, 200, {
          owner,
          actor: owner ? actor(owner) : null,
          attentionFeatures,
          needsSetup: !store.hasAccount(),
          localOnly: options.localOnly === true,
          google: {
            enabled: googleAuth.enabled,
            ...(owner
              ? { linked: store.googleIdentity(owner), hasPassword: store.hasPassword(owner) }
              : {}),
          },
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
        const paired = store.redeem(b.code, b.name);
        return json(res, 200, { ...paired, actor: actor(paired.accountId) });
      }
      if (path === '/api/device-context' && req.method === 'GET') {
        const device = store.deviceToken(bearer(req));
        return json(res, 200, {
          executionDeviceId: device.id,
          actor: actor(device.owner),
          attentionFeatures,
        });
      }
      if (path === '/api/account-invitations/redeem' && req.method === 'POST') {
        assert(req.headers.origin === origin, 403, '请求来源不匹配');
        assert(!options.localOnly, 403, '本机模式不提供远程账号注册');
        const input = z
          .object({
            invitation: z.string().min(20).max(200),
            email: z.string().email().max(320),
            password: z.string().min(12).max(1024),
          })
          .strict()
          .parse(await body(req, 8192));
        const secret = await store.redeemAccountInvitation(
          input.invitation,
          input.email,
          input.password,
        );
        res.setHeader('Set-Cookie', loginCookie(secret));
        return json(res, 200, { owner: store.owner(secret) });
      }
      const owner = path.startsWith('/api/') ? store.owner(cookie(req)) : null;
      const expectedAccount = url.searchParams.get('expectedAccount');
      const accountCurrent = () => {
        assert(
          !closing && owner && store.owner(cookie(req)) === owner,
          401,
          '账号登录已失效，请重新登录',
        );
        if (expectedAccount !== null)
          assert(
            id.safeParse(expectedAccount).success && expectedAccount === owner,
            403,
            '账号已改变，未执行目录操作',
          );
      };
      if (path.startsWith('/api/') && expectedAccount !== null) accountCurrent();
      if (path === '/api/account-invitations' && req.method === 'POST') {
        assert(req.headers.origin === origin, 403, '请求来源不匹配');
        assert(!options.localOnly, 403, '本机模式不提供远程账号邀请');
        z.object({})
          .strict()
          .parse(await body(req, 1024));
        return json(res, 200, store.inviteAccount(owner!));
      }
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
        // Revoke this exact token. A delayed browser response must not overwrite
        // another tab's newer login cookie; an invalid cookie confers no identity.
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
        accountCurrent();
        return json(res, 200, { code: store.pair(owner!, input.workspaceId), expiresIn: 300 });
      }
      if (path === '/api/workspace-catalog' && req.method === 'GET') {
        store.db.exec('SAVEPOINT workspace_catalog_snapshot');
        let snapshot;
        try {
          const live = (deviceId: string) =>
            online(deviceId) ? bridges.get(deviceId)!.workspaces : [];
          snapshot = workspaceCatalogSnapshotSchema.parse({
            version: 1,
            identity: { owner: owner!, actor: actor(owner!) },
            workspaces: store.catalog.list(owner!, live),
            devices: store.devices(owner!).map((device) => ({
              id: device.id,
              name: device.name,
              online: online(String(device.id)),
              workspaces: live(String(device.id)),
            })),
          });
          store.db.exec('RELEASE workspace_catalog_snapshot');
        } catch (error) {
          store.db.exec(
            'ROLLBACK TO workspace_catalog_snapshot; RELEASE workspace_catalog_snapshot',
          );
          throw error;
        }
        return json(res, 200, snapshot);
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
      function sessionBoundary(
        deviceId: string,
        runtime: RuntimeWorkspace,
        localProjectId?: string,
        catalogueCurrent?: () => void,
      ) {
        const snapshot = structuredClone(runtime),
          socket = bridges.get(deviceId)?.socket;
        // Legacy device and host-wide list requests have no single project route.
        // Pin every registered project and its current catalogue assignment.
        const mappings = () =>
          store.catalog
            .list(owner!, (device) => (online(device) ? bridges.get(device)!.workspaces : []))
            .flatMap((space) =>
              space.hosts
                .filter(
                  (host) => host.deviceId === deviceId && host.runtimeWorkspaceId === snapshot.id,
                )
                .flatMap((host) =>
                  space.replicas
                    .filter(
                      (replica) =>
                        replica.hostId === host.id &&
                        (!localProjectId || replica.localProjectId === localProjectId),
                    )
                    .map((replica) => [
                      space.id,
                      host.id,
                      replica.id,
                      replica.projectId,
                      replica.localProjectId,
                    ]),
                ),
            );
        // Replica routes already pin their exact mapping. Only the legacy
        // device/host-wide route needs to enumerate all of its assignments.
        const originalMappings = catalogueCurrent && localProjectId ? undefined : mappings();
        const current = (feature?: string) => {
          assert(!closing, 409, '执行服务正在关闭');
          assert(store.owner(cookie(req)) === owner, 401, '请先登录');
          assert(
            online(deviceId) && bridges.get(deviceId)?.socket === socket,
            409,
            '执行主机连接已变化，请核查原操作',
          );
          const device = store.device(owner!, deviceId);
          const active = bridges.get(deviceId)?.workspaces.find((w) => w.id === snapshot.id);
          const projects = (w: RuntimeWorkspace) =>
            w.projects.filter((p) => !localProjectId || p.id === localProjectId);
          assert(
            online(deviceId) &&
              bridges.get(deviceId)?.socket === socket &&
              active?.userId === snapshot.userId &&
              active?.machineId === snapshot.machineId &&
              device.machine_id === snapshot.machineId &&
              isDeepStrictEqual(projects(active), projects(snapshot)) &&
              (!localProjectId || active.projects.some((p) => p.id === localProjectId)) &&
              (!feature || active.features?.includes(feature)),
            409,
            '会话请求的执行范围已变化，请重新读取',
          );
          catalogueCurrent?.();
          if (originalMappings)
            assert(
              isDeepStrictEqual(mappings(), originalMappings),
              409,
              '会话请求的项目归属已变化，请重新读取',
            );
          return active;
        };
        current();
        return { deviceId, runtime: snapshot, current };
      }
      function readSessionInput(sessionId: string) {
        id.parse(sessionId);
        const version = url.searchParams.get('version');
        if (version !== null)
          sessionBase64Schema.refine((value) => value.length <= 64 * 1024).parse(version);
        return { sessionId, version: version ?? undefined };
      }
      async function sessionResponse(
        boundary: ReturnType<typeof sessionBoundary>,
        method: 'sessions' | 'sessions-page' | 'session' | 'mutate' | 'session-action' | 'cancel',
        input: any,
        localProjectId?: string,
      ) {
        const feature =
          method === 'session-action'
            ? 'session-actions'
            : method === 'sessions-page'
              ? SESSION_PAGE_FEATURE
              : method === 'mutate' && input.kind === 'turn'
                ? RETIRED_RECORDS_FEATURE
                : undefined;
        const command = hostCommandSchema.parse({
          method,
          workspaceId: boundary.runtime.id,
          localProjectId,
          params: input,
        });
        if (method === 'mutate' && input.kind === 'turn')
          assert(
            boundary.runtime.features?.includes(RETIRED_RECORDS_FEATURE),
            409,
            HOST_UPGRADE_REQUIRED,
          );
        boundary.current(feature);
        let raw: unknown, failed: { error: unknown } | undefined;
        try {
          raw = await request(
            boundary.deviceId,
            method,
            boundary.runtime.id,
            input,
            localProjectId,
            owner!,
          );
        } catch (error) {
          failed = { error };
        }
        // Errors are deliveries too: no raw host diagnostic crosses a revoked scope.
        boundary.current(feature);
        if (failed) {
          const error = failed.error;
          throw new AppError(
            error instanceof AppError &&
              [400, 401, 403, 404, 409, 410, 413, 429, 504].includes(error.status)
              ? error.status
              : 502,
            error instanceof AppError && error.status === 410
              ? RETIRED_SESSION_FEATURE
              : method === 'session' || method === 'sessions' || method === 'sessions-page'
                ? '会话读取失败，请手动重新读取'
                : '会话操作未能确认，请手动查询或重试原操作',
            method !== 'cancel' && error instanceof AppError && error.rejected,
          );
        }
        const result = await validateHostResponse(raw, {
          command,
          workspace: boundary.runtime,
          current: () => boundary.current(feature),
        });
        boundary.current(feature);
        return result;
      }
      const parts = path.split('/').filter(Boolean);
      if (
        parts[0] === 'api' &&
        parts[1] === 'workspaces' &&
        parts[2] &&
        parts[3] === 'replicas' &&
        parts[4] &&
        parts[5] === 'context' &&
        parts.length === 6 &&
        req.method === 'GET'
      )
        return json(res, 200, replicaContext(owner!, id.parse(parts[2]), id.parse(parts[4])));
      if (path === '/api/workspaces') {
        if (req.method === 'GET')
          return json(
            res,
            200,
            store.catalog.list(owner!, (id) => (online(id) ? bridges.get(id)!.workspaces : [])),
          );
        if (req.method === 'POST') {
          const input = workspaceInputSchema.parse(await body(req));
          accountCurrent();
          const workspace = store.catalog.create(owner!, input.name);
          changed(owner!, '');
          return json(res, 200, workspace);
        }
      }
      if (parts[0] === 'api' && parts[1] === 'collaboration') {
        if (parts.length === 2 && req.method === 'GET') {
          return json(res, 200, {
            actor: actor(owner!),
            workspaces: store.catalog.collaborationList(owner!, (device) =>
              online(device) ? bridges.get(device)!.workspaces : [],
            ),
          });
        }
        assert(
          parts.length === 6 && ['read', 'sync', 'member', 'enable', 'offer'].includes(parts[5]!),
          404,
          '协作接口不存在',
        );
        const [workspaceId, replicaId, sessionId] = parts.slice(2, 5);
        id.parse(workspaceId);
        id.parse(replicaId);
        id.parse(sessionId);
        const access = store.catalog.collaborationAccess(owner!, workspaceId!),
          replica = store.catalog.replica(access.owner, workspaceId!, replicaId!),
          host = replica.host,
          socket = bridges.get(host.device_id)?.socket,
          runtime = bridges
            .get(host.device_id)
            ?.workspaces.find((entry) => entry.id === host.runtime_id);
        assert(
          runtime &&
            online(host.device_id) &&
            bridges.get(host.device_id)?.attentionReady &&
            runtime.features?.includes(COLLABORATION_FEATURE),
          409,
          '共享会话主机离线或尚未支持协作',
        );
        const context = collaborationContextSchema.parse({
          actor: actor(owner!),
          ownerActor: actor(access.owner),
          executionDeviceId: host.device_id,
          machineId: runtime.machineId,
          catalogWorkspaceId: workspaceId,
          projectId: replica.project_id,
          replicaId,
          runtimeWorkspaceId: runtime.id,
          localProjectId: replica.local_id,
          sessionId,
        });
        const scope = {
          authorityId: context.actor.authorityId,
          workspaceId: workspaceId!,
          projectId: replica.project_id,
          sessionId: sessionId!,
        };
        const current = () => {
          assert(!closing && store.owner(cookie(req)) === owner, 401, '协作登录已失效');
          assert(
            isDeepStrictEqual(store.catalog.collaborationAccess(owner!, workspaceId!), access),
            403,
            '协作权限已变化',
          );
          store.device(access.owner, host.device_id);
          assert(
            online(host.device_id) &&
              bridges.get(host.device_id)?.socket === socket &&
              isDeepStrictEqual(
                store.catalog.replica(access.owner, workspaceId!, replicaId!),
                replica,
              ) &&
              isDeepStrictEqual(
                bridges.get(host.device_id)?.workspaces.find((entry) => entry.id === runtime.id),
                runtime,
              ),
            409,
            '协作请求的主机或项目绑定已变化',
          );
        };
        current();
        const method = 'collaboration-' + parts[5];
        let input: unknown = {};
        if (parts[5] === 'read') assert(req.method === 'GET', 405, '读取共享会话需要 GET');
        else {
          assert(req.method === 'POST' && req.headers.origin === origin, 403, '协作请求来源不匹配');
          if (parts[5] === 'sync') {
            const sync = collaborationSyncRequestSchema.parse(
              await body(req, COLLABORATION_LIMITS.requestBytes),
            );
            assert(
              collaborationKey(sync.scope) === collaborationKey(scope),
              400,
              '同步范围与原路由不匹配',
            );
            input = sync;
          } else if (parts[5] === 'offer') {
            const offer = collaborationOfferSchema.parse(
              await body(req, COLLABORATION_LIMITS.requestBytes),
            );
            assert(
              collaborationKey(offer.scope) === collaborationKey(scope),
              400,
              'RPC 意图与原路由不匹配',
            );
            input = offer;
          } else if (parts[5] === 'enable') {
            assert(access.role === 'owner', 403, '只有所有者可以开启共享');
            input = z
              .object({})
              .strict()
              .parse(await body(req, 1024));
          } else {
            assert(access.role === 'owner', 403, '只有所有者可以管理协作成员');
            const member = collaborationMemberSchema.parse(await body(req, 4096));
            assert(
              member.accountId !== owner &&
                store.db.prepare('SELECT 1 FROM account WHERE id=?').get(member.accountId),
              404,
              '协作账号不可用',
            );
            input = member;
          }
        }
        current();
        let raw: unknown, failure: unknown;
        try {
          raw = await request(
            host.device_id,
            method,
            runtime.id,
            input,
            replica.local_id,
            access.owner,
            context,
          );
        } catch (error) {
          failure = error;
        }
        current();
        if (failure) throw failure;
        if (parts[5] === 'sync') {
          return json(
            res,
            200,
            validateCollaborationSyncResponse(raw, collaborationSyncRequestSchema.parse(input)),
          );
        }
        if (parts[5] === 'member') {
          const member = collaborationMemberSchema.parse(input),
            result = z
              .object({
                confirmed: z.literal(true),
                accountId: id,
                role: collaborationMemberSchema.shape.role,
              })
              .strict()
              .parse(raw);
          assert(
            result.accountId === member.accountId && result.role === member.role,
            502,
            '成员授权回执不匹配',
          );
          store.catalog.grantCollaboration(
            access.owner,
            workspaceId!,
            member.accountId,
            member.role,
          );
          changed(access.owner, host.device_id, runtime.id);
          for (const [ws, viewer] of viewers)
            if (viewer.owner === member.accountId)
              send(ws, { type: 'collaboration-changed', deviceId: '' });
          return json(res, 200, result);
        }
        if (parts[5] === 'offer') {
          const offer = collaborationOfferSchema.parse(input),
            receipt = collaborationOfferReceiptSchema.parse(raw);
          assert(
            receipt.operationId === offer.operationId &&
              collaborationKey(receipt.scope) === collaborationKey(scope),
            502,
            'RPC 送达回执与原意图不匹配',
          );
          return json(res, 200, receipt);
        }
        const result = collaborationReadResponseSchema.parse(raw),
          target = result.target;
        assert(
          collaborationKey(result.scope) === collaborationKey(scope) &&
            target.executionDeviceId === host.device_id &&
            target.workspaceId === runtime.id &&
            target.machineId === runtime.machineId &&
            target.userId === runtime.userId &&
            target.localProjectId === replica.local_id &&
            target.sessionId === sessionId &&
            result.session.meta.id === sessionId &&
            result.session.meta.userId === runtime.userId &&
            result.session.meta.machineId === runtime.machineId &&
            result.session.meta.project.localProjectId === replica.local_id &&
            result.session.meta.agentConfigId === target.agentId,
          502,
          '共享会话响应不属于原执行范围',
        );
        return json(res, 200, result);
      }
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2]) {
        const workspaceId = parts[2];
        store.catalog.workspace(owner!, workspaceId);
        if (parts[3] === 'rename' && req.method === 'POST') {
          const input = workspaceInputSchema.parse(await body(req));
          accountCurrent();
          store.catalog.rename(owner!, workspaceId, input.name);
          changed(owner!, '');
          return json(res, 200, { ok: true });
        }
        if (parts[3] === 'projects' && parts.length === 4 && req.method === 'POST') {
          const input = projectInputSchema.parse(await body(req));
          accountCurrent();
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
            accountCurrent();
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
          if (parts[5] === 'sessions' && parts.length === 6 && req.method === 'GET') {
            const runtime = bridges
              .get(host.device_id)
              ?.workspaces.find((w) => w.id === host.runtime_id);
            assert(runtime, 409, '本地主机工作区不可用');
            const boundary = sessionBoundary(host.device_id, runtime, undefined, () => {
              assert(
                isDeepStrictEqual(store.catalog.binding(owner!, workspaceId, host.id), host),
                409,
                '主机工作区已变化',
              );
            });
            return json(res, 200, await sessionResponse(boundary, 'sessions', {}, undefined));
          }
        }
        if (parts[3] === 'replicas' && parts[4]) {
          const replica = store.catalog.replica(owner!, workspaceId, parts[4]),
            host = replica.host;
          if (parts[5] === 'assign' && req.method === 'POST') {
            const input = replicaAssignmentSchema.parse(await body(req));
            accountCurrent();
            store.catalog.assign(owner!, workspaceId, replica.id, input.projectId);
            changed(owner!, host.device_id);
            return json(res, 200, { ok: true });
          }
          const runtime = bridges
            .get(host.device_id)
            ?.workspaces.find((w) => w.id === host.runtime_id);
          assert(
            runtime && runtime.projects.some((p) => p.id === replica.local_id),
            409,
            '项目副本离线或已从主机移除',
          );
          if (parts[5] === 'attention' || (parts[5] === 'sessions' && parts[7] === 'attention')) {
            // Attention remains bound to the original login, socket and catalogue
            // assignment across request-body and Host waits. Bearers do not waive CSRF.
            if (req.method !== 'GET') assert(req.headers.origin === origin, 403, '请求来源不匹配');
            const attentionSecret = cookie(req),
              attentionGeneration = attentionOriginGeneration,
              attentionSocket = bridges.get(host.device_id)?.socket;
            let continueFeature = RETIRED_RECORDS_FEATURE;
            const currentAttention = (method: string) => {
              assert(
                !closing && server.listening && attentionOriginGeneration === attentionGeneration,
                409,
                '待办请求所属服务已变化，请重新读取',
              );
              assert(store.owner(attentionSecret) === owner, 401, '待办请求所属登录已失效');
              store.device(owner!, host.device_id);
              const connected = bridges.get(host.device_id);
              assert(
                online(host.device_id) &&
                  connected &&
                  connected.socket === attentionSocket &&
                  connected.attentionReady &&
                  connected.workspaces.find((item) => item.id === host.runtime_id) === runtime &&
                  runtime.features?.includes(ATTENTION_FEATURE) &&
                  runtime.features?.includes(ACTOR_FEATURE) &&
                  (method !== 'attention-continue' ||
                    (runtime.features?.includes(FOLLOWUP_FEATURE) &&
                      runtime.features.includes(continueFeature))),
                409,
                '待办请求所属执行连接已变化，请重新读取',
              );
              const currentReplica = store.catalog.replica(owner!, workspaceId, replica.id);
              assert(
                currentReplica.project_id === replica.project_id &&
                  currentReplica.local_id === replica.local_id &&
                  currentReplica.host.id === host.id &&
                  currentReplica.host.workspace_id === host.workspace_id &&
                  currentReplica.host.runtime_id === host.runtime_id &&
                  currentReplica.host.device_id === host.device_id,
                409,
                '待办请求所属项目副本已变化，请重新读取',
              );
            };
            assert(
              bridges.get(host.device_id)?.attentionReady &&
                runtime.features?.includes(ATTENTION_FEATURE) &&
                runtime.features?.includes(ACTOR_FEATURE),
              409,
              '请先升级并连接支持待办工作台的执行电脑',
            );
            const context = attentionContextSchema.parse({
              actor: actor(owner!),
              executionDeviceId: host.device_id,
              machineId: runtime.machineId,
              catalogWorkspaceId: workspaceId,
              projectId: replica.project_id,
              replicaId: replica.id,
              runtimeWorkspaceId: host.runtime_id,
              localProjectId: replica.local_id,
              ...(parts[5] === 'sessions' ? { sessionId: decodeURIComponent(parts[6]) } : {}),
            });
            const respondAttention = async (method: string, params: unknown) => {
              currentAttention(method);
              let result: unknown;
              try {
                result = await request(
                  host.device_id,
                  method,
                  host.runtime_id,
                  params,
                  replica.local_id,
                  undefined,
                  context,
                );
              } finally {
                currentAttention(method);
              }
              return json(res, 200, result);
            };
            if (
              ((parts[5] === 'attention' && parts.length === 6) ||
                (parts[5] === 'sessions' && parts.length === 8)) &&
              req.method === 'GET'
            ) {
              const query = Object.fromEntries(url.searchParams);
              const input = attentionListQuerySchema.parse({
                ...query,
                ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
              });
              return await respondAttention(
                context.sessionId ? 'attention-items' : 'attention-list',
                input,
              );
            }
            assert(parts[5] === 'sessions' && parts[8], 404, '未找到待办操作');
            const itemId = z.string().min(1).max(1024).parse(decodeURIComponent(parts[8]));
            let method: string;
            let input: unknown;
            if (parts.length === 9 && req.method === 'GET') {
              method = 'attention-detail';
            } else {
              assert(parts.length === 10 && req.method === 'POST', 404, '未找到待办操作');
              switch (parts[9]) {
                case 'seen':
                  method = 'attention-seen';
                  input = attentionSeenSchema.parse(await body(req));
                  break;
                case 'disposition':
                  method = 'attention-disposition';
                  input = attentionDispositionSchema.parse(await body(req));
                  break;
                case 'permission':
                  method = 'attention-permission';
                  input = attentionPermissionSchema.parse(await body(req));
                  break;
                case 'continue': {
                  assert(
                    runtime.features?.includes(FOLLOWUP_FEATURE),
                    409,
                    '请先升级支持后续关联的执行电脑',
                  );
                  method = 'attention-continue';
                  const followup = attentionContinueSchema.parse(await body(req));
                  const turn = attentionContinueInput(followup);
                  if ('turn' in followup) {
                    continueFeature = SESSION_INTENTS_FEATURE;
                    assert(
                      followup.turn.userId === runtime.userId &&
                        followup.turn.machineId === runtime.machineId &&
                        followup.turn.localProjectId === context.localProjectId,
                      400,
                      '后续指令与原事项执行身份不匹配',
                    );
                  }
                  assert(
                    turn.workspaceId === context.runtimeWorkspaceId &&
                      turn.sessionId === context.sessionId,
                    400,
                    '后续指令与原事项执行目标不匹配',
                  );
                  input = followup;
                  break;
                }
                default:
                  throw new AppError(404, '未找到待办操作');
              }
            }
            return await respondAttention(method, { itemId, input });
          }
          if (replicaCommand) {
            const boundary = sessionBoundary(host.device_id, runtime, replica.local_id, () => {
              assert(
                isDeepStrictEqual(store.catalog.replica(owner!, workspaceId, replica.id), replica),
                409,
                '请求的项目副本已变化，请核查原操作',
              );
            });
            return json(
              res,
              200,
              await forwardReplicaCommand(
                {
                  method: replicaCommand,
                  segments: parts.slice(5),
                  query: url.searchParams,
                  body: (limit) => body(req, limit),
                },
                {
                  catalogWorkspaceId: workspaceId,
                  runtimeWorkspaceId: host.runtime_id,
                  localProjectId: replica.local_id,
                  workspace: boundary.runtime,
                  current: boundary.current,
                  dispatch: (command) =>
                    request(
                      host.device_id,
                      command.method,
                      command.workspaceId,
                      command.params,
                      command.localProjectId,
                      owner!,
                    ),
                  dispatched: () => {
                    scopedActionDispatched = true;
                  },
                },
              ),
            );
          }
        }
      }
      if (parts[0] === 'api' && parts[1] === 'devices' && parts[2]) {
        const d = store.device(owner!, parts[2]);
        if (parts[3] === 'revoke' && req.method === 'POST') {
          accountCurrent();
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
        const boundary = sessionBoundary(d.id, ws);
        if (parts[3] === 'sessions' && [4, 5].includes(parts.length) && req.method === 'GET') {
          const input = parts.length === 5 ? readSessionInput(parts[4]!) : {};
          return json(
            res,
            200,
            await sessionResponse(boundary, parts.length === 5 ? 'session' : 'sessions', input),
          );
        }
        if (parts[3] === 'mutations' && parts.length === 4 && req.method === 'POST') {
          const input = mutationSchema.strict().parse(await body(req));
          assert(ws.id === input.workspaceId, 400, '工作区不匹配');
          return json(res, 200, await sessionResponse(boundary, 'mutate', input));
        }
        if (parts[3] === 'session-actions' && parts.length === 4 && req.method === 'POST') {
          const input = sessionActionSchema.parse(await body(req, 4096));
          assert(ws.id === input.workspaceId, 400, '工作区不匹配');
          assert(
            ws.projects.some((project) => project.id === input.localProjectId),
            404,
            '项目副本不可用',
          );
          return json(
            res,
            200,
            await sessionResponse(boundary, 'session-action', input, input.localProjectId),
          );
        }
        if (parts[3] === 'cancel' && parts.length === 4 && req.method === 'POST') {
          const input = sessionCancelSchema.parse(await body(req, 4096));
          return json(res, 200, await sessionResponse(boundary, 'cancel', input));
        }
      }
      assert(req.method === 'GET' && !path.startsWith('/api/'), 404, '未找到');
      const publicDir = resolve(options.publicDir ?? 'dist/public'),
        filename = resolve(
          publicDir,
          path === '/' || path === '/auth/google/complete' ? 'index.html' : '.' + path,
        );
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
      if (path.startsWith('/bridge/v4')) {
        socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n');
        return;
      }
      if (path === '/bridge') {
        const d = store.deviceToken(bearer(req));
        wss.handleUpgrade(req, socket, head, (ws) => {
          const previous = bridges.get(d.id);
          if (previous) rejectFileReads(d.id, previous.socket);
          previous?.socket.close(1008, 'replaced');
          bridges.set(d.id, { socket: ws, ready: false, attentionReady: false, workspaces: [] });
          ws.on('message', (raw) => {
            try {
              const current = store.deviceToken(bearer(req));
              assert(bridges.get(d.id)?.socket === ws, 409, '连接已替换');
              const message = JSON.parse(raw.toString());
              if (message.type === 'hello') {
                const b = helloSchema.parse(message);
                const attentionReady = message.attentionActor !== undefined;
                if (attentionReady)
                  assert(
                    actorKey(actorSchema.parse(message.attentionActor)) ===
                      actorKey(actor(current.owner)),
                    403,
                    '待办账号身份与设备配对不匹配',
                  );
                if (!attentionReady)
                  for (const workspace of b.workspaces)
                    workspace.features = workspace.features?.filter(
                      (feature) => !attentionFeatures.includes(feature),
                    );
                const deviceMetadata = store.bind(
                  current,
                  b.machineId,
                  b.workspaces,
                  b.deviceMetadata,
                );
                bridges.set(d.id, {
                  socket: ws,
                  ready: true,
                  attentionReady,
                  workspaces: b.workspaces,
                });
                changed(d.owner, d.id);
                send(ws, {
                  type: 'ready',
                  actor: actor(current.owner),
                  attentionFeatures,
                  ...(deviceMetadata ? { deviceMetadata } : {}),
                });
                for (const v of viewers.values())
                  if (v.watch?.deviceId === d.id) send(ws, { type: 'watch', ...v.watch });
              } else if (message.type === 'unavailable') {
                rejectFileReads(d.id, ws);
                bridges.set(d.id, {
                  socket: ws,
                  ready: false,
                  attentionReady: false,
                  workspaces: [],
                });
                changed(d.owner, d.id);
              } else if (message.type === 'attention-changed') {
                const notice = z
                  .object({
                    type: z.literal('attention-changed'),
                    actor: actorSchema,
                    workspaceId: z.string().min(1).max(160),
                    sessionId: z.string().min(1).max(160),
                  })
                  .strict()
                  .parse(message);
                assert(
                  bridges.get(d.id)?.attentionReady &&
                    actorKey(notice.actor) === actorKey(actor(current.owner)) &&
                    bridges
                      .get(d.id)
                      ?.workspaces.some((workspace) => workspace.id === notice.workspaceId),
                  403,
                  '待办变更不属于当前授权连接',
                );
                changed(current.owner, d.id, notice.workspaceId, {
                  scope: 'attention',
                  docId: notice.sessionId,
                  actor: notice.actor,
                });
              } else if (message.type === 'changed') {
                changed(d.owner, d.id, message.workspaceId, {
                  scope: 'doc',
                  docId: message.sessionId,
                });
              } else if (
                message.type === 'github-changed' ||
                message.type === 'skills-changed' ||
                message.type === 'mcp-changed'
              ) {
                const event = z
                  .object({
                    type: z.enum(['github-changed', 'skills-changed', 'mcp-changed']),
                    workspaceId: z.string().min(1).max(200),
                  })
                  .strict()
                  .parse(message);
                const feature =
                  event.type === 'mcp-changed'
                    ? MCP_FEATURE
                    : event.type === 'skills-changed'
                      ? SKILLS_FEATURE
                      : GITHUB_FEATURE;
                const scope =
                  event.type === 'mcp-changed'
                    ? 'mcp'
                    : event.type === 'skills-changed'
                      ? 'skills'
                      : 'github';
                assert(
                  bridges
                    .get(d.id)
                    ?.workspaces.some(
                      (w) => w.id === event.workspaceId && w.features?.includes(feature),
                    ),
                  409,
                  '配置事件范围不匹配',
                );
                for (const [viewer, identity] of viewers) {
                  if (identity.owner !== d.owner) continue;
                  try {
                    assert(store.owner(identity.secret) === d.owner, 401, '请先登录');
                    send(viewer, {
                      type: 'changed',
                      deviceId: d.id,
                      workspaceId: event.workspaceId,
                      room: { scope },
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
      const next = new URL(value).origin;
      if (next !== origin) {
        attentionOriginGeneration++;
      }
      origin = next;
      googleAuth.setOrigin(origin);
    },
    close: async () => {
      closing = true;
      googleAuth.close();
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
