import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { serveStatic } from './static';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { Store, type Device } from './accounts';
import { AppError, assert, helloSchema, mutationSchema } from '../protocol';
import type { RuntimeWorkspace } from '../protocol';
import { workspaceInputSchema, projectInputSchema, replicaAssignmentSchema } from '../catalog';
export function createApp(
  store: Store,
  options: { origin: string; setupToken: string; publicDir?: string; localOnly?: boolean },
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
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failures = new Map<string, { count: number; until: number }>();
  const online = (id: string) =>
    bridges.get(id)?.ready === true && bridges.get(id)?.socket.readyState === WebSocket.OPEN;
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
  function request(
    device: string,
    method: string,
    workspaceId: string,
    params: unknown,
    localProjectId?: string,
  ): Promise<unknown> {
    assert(online(device), 409, '执行电脑不可达，指令未送达');
    assert(commands.size < 64, 429, '请求过多，请稍后再试');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        commands.delete(requestId);
        reject(new AppError(504, '执行主机尚未确认，请重试确认同一请求'));
      }, 30000);
      commands.set(requestId, { device, resolve, reject, timer });
      send(bridges.get(device)!.socket, {
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
  async function body(req: IncomingMessage) {
    assert(req.headers['content-type']?.startsWith('application/json'), 415, '需要 JSON 请求');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= 34 * 1024 * 1024, 413, '请求过大');
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url ?? '/', origin),
        path = url.pathname;
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
        store.logout(secret);
        for (const [ws, v] of viewers) if (v.secret === secret) ws.close(1000, 'logout');
        res.setHeader('Set-Cookie', 'personal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(res, 200, { ok: true });
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
          rejected: e instanceof AppError && e.rejected,
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
                bridges.set(d.id, { socket: ws, ready: false, workspaces: [] });
                changed(d.owner, d.id);
              } else if (message.type === 'changed') {
                changed(d.owner, d.id, message.workspaceId, {
                  scope: 'doc',
                  docId: message.sessionId,
                });
              } else if (message.type === 'response') {
                const c = commands.get(message.requestId);
                if (c?.device === d.id) {
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
