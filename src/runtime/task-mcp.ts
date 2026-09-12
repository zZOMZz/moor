import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
import {
  TASK_LIMITS,
  taskToolDefinitions,
  taskToolInputSchemas,
  type TaskToolName,
} from '../task-protocol';

export type TaskMcpOptions = {
  tools?: typeof taskToolDefinitions;
  current(): void;
  call(name: TaskToolName, args: Record<string, unknown>): Promise<unknown>;
};
export type TaskMcp = {
  endpoint: { url: string; token: string };
  close(): Promise<void>;
};
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const rpcId = z.union([z.string().min(1).max(200), z.number().int().safe()]);
const messageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: rpcId.optional(),
    method: z.string().max(100),
    params: z.record(z.unknown()).optional(),
  })
  .strict();
const metaSchema = z.object({ progressToken: rpcId.optional() }).passthrough();
const callSchema = z
  .object({ name: z.string(), arguments: z.record(z.unknown()), _meta: metaSchema.optional() })
  .strict();

// One ephemeral, authenticated capability for one parent turn. This service
// exposes only the fixed task protocol, not URLs, shell commands or MCP proxying.
export async function createTaskMcp(options: TaskMcpOptions): Promise<TaskMcp> {
  if (options.tools && JSON.stringify(options.tools) !== JSON.stringify(taskToolDefinitions))
    throw new Error('任务工具定义无效');
  try {
    options.current();
  } catch {
    throw new Error('任务工具授权已失效，未创建连接');
  }
  const token = randomBytes(32).toString('base64url'),
    secret = Buffer.from('Bearer ' + token),
    sockets = new Set<Socket>(),
    responses = new Set<ServerResponse>(),
    activeIds = new Set<string>();
  let closed = false,
    active = 0,
    initialized = false,
    ready = false,
    negotiated = '',
    origin = '',
    closeResult: Promise<void> | undefined;
  const revoked = new AbortController();
  const current = () => {
    if (closed) throw new Error('任务工具已关闭');
    options.current();
  };
  const reply = (response: ServerResponse, status: number, value?: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (value === undefined) {
      response.writeHead(status);
      response.end();
      return;
    }
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > TASK_LIMITS.responseBytes)
      throw new Error('任务工具响应超出限制');
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
    });
    response.end(data);
  };
  const error = (
    response: ServerResponse,
    status: number,
    id: string | number | null,
    code: number,
    message: string,
  ) => reply(response, status, { jsonrpc: '2.0', id, error: { code, message } });
  const authorized = (request: IncomingMessage) => {
    const headers = request.headers,
      seen = new Set<string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i]!.toLowerCase();
      if (
        seen.has(name) &&
        [
          'authorization',
          'host',
          'origin',
          'content-type',
          'accept',
          'content-length',
          'mcp-protocol-version',
        ].includes(name)
      )
        return false;
      seen.add(name);
    }
    const auth = Buffer.from(headers.authorization ?? '');
    return (
      request.socket.remoteAddress === '127.0.0.1' &&
      headers.host === origin.slice('http://'.length) &&
      (headers.origin === undefined || headers.origin === origin) &&
      auth.length === secret.length &&
      timingSafeEqual(auth, secret) &&
      headers.cookie === undefined &&
      headers['content-encoding'] === undefined &&
      headers['proxy-authorization'] === undefined &&
      headers['mcp-session-id'] === undefined
    );
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.maxConnections = 16;
  server.keepAliveTimeout = 1000;
  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  async function handle(request: IncomingMessage, response: ServerResponse) {
    let id: string | number | null = null,
      key: string | undefined,
      counted = false;
    responses.add(response);
    response.once('close', () => responses.delete(response));
    try {
      current();
      if (!authorized(request)) {
        error(response, 403, null, -32000, '任务工具连接未授权');
        return;
      }
      if (request.url !== '/mcp') {
        error(response, 404, null, -32600, '任务工具路径无效');
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        error(response, 405, null, -32600, '任务工具只接受 POST');
        return;
      }
      const accept = request.headers.accept?.split(',').map((part) => part.trim().split(';')[0]);
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] ?? '',
        ) ||
        !accept?.includes('application/json') ||
        !accept.includes('text/event-stream')
      ) {
        error(response, 415, null, -32600, '任务工具请求格式无效');
        return;
      }
      const version = request.headers['mcp-protocol-version'];
      if (
        version !== undefined &&
        (typeof version !== 'string' ||
          !versions.has(version) ||
          (negotiated && version !== negotiated))
      ) {
        error(response, 400, null, -32600, '任务工具协议版本无效');
        return;
      }
      if (Number(request.headers['content-length'] ?? 0) > TASK_LIMITS.requestBytes) {
        error(response, 413, null, -32600, '任务工具请求超出限制');
        return;
      }
      if (active >= TASK_LIMITS.parallel) {
        error(response, 429, null, -32000, '任务工具并发请求已达上限');
        return;
      }
      active++;
      counted = true;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        current();
        bytes += chunk.length;
        if (bytes > TASK_LIMITS.requestBytes) {
          error(response, 413, null, -32600, '任务工具请求超出限制');
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      current();
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        error(response, 400, null, -32700, '任务工具 JSON 无效');
        return;
      }
      const parsed = messageSchema.safeParse(raw);
      if (!parsed.success) {
        error(response, 400, null, -32600, '任务工具消息无效');
        return;
      }
      const message = parsed.data;
      id = message.id ?? null;
      if (message.method === 'notifications/initialized' && message.id === undefined) {
        if (!initialized || Object.keys(message.params ?? {}).some((name) => name !== '_meta')) {
          error(response, 400, null, -32600, '任务工具尚未初始化');
          return;
        }
        ready = true;
        reply(response, 202);
        return;
      }
      if (message.id === undefined) {
        error(response, 400, null, -32600, '任务工具请求缺少标识');
        return;
      }
      key = typeof id + ':' + id;
      if (activeIds.has(key)) {
        key = undefined;
        error(response, 409, id, -32000, '原任务工具请求仍在处理中');
        return;
      }
      activeIds.add(key);
      if (message.method === 'initialize') {
        const params = z
          .object({
            protocolVersion: z.string().max(40),
            capabilities: z.record(z.unknown()),
            clientInfo: z
              .object({ name: z.string().max(200), version: z.string().max(100) })
              .passthrough(),
            _meta: metaSchema.optional(),
          })
          .strict()
          .safeParse(message.params);
        if (!params.success) {
          error(response, 400, id, -32602, '任务工具初始化参数无效');
          return;
        }
        const requested = versions.has(params.data.protocolVersion)
          ? params.data.protocolVersion
          : '2025-11-25';
        if (initialized && requested !== negotiated) {
          error(response, 409, id, -32600, '任务工具协议已协商');
          return;
        }
        initialized = true;
        negotiated = requested;
        reply(response, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'moor-tasks', version: '1.0.0' },
          },
        });
        return;
      }
      if (!ready) {
        error(response, 409, id, -32000, '任务工具尚未初始化');
        return;
      }
      if (message.method === 'tools/list') {
        if (
          !z
            .object({ _meta: metaSchema.optional() })
            .strict()
            .safeParse(message.params ?? {}).success
        ) {
          error(response, 400, id, -32602, '任务工具列表参数无效');
          return;
        }
        reply(response, 200, { jsonrpc: '2.0', id, result: { tools: taskToolDefinitions } });
        return;
      }
      if (message.method !== 'tools/call') {
        error(response, 400, id, -32601, '不支持此任务工具方法');
        return;
      }
      const call = callSchema.safeParse(message.params);
      const name = call.success ? (call.data.name as TaskToolName) : undefined;
      if (!name || !Object.hasOwn(taskToolInputSchemas, name)) {
        error(response, 400, id, -32602, '任务工具参数无效');
        return;
      }
      const input = taskToolInputSchemas[name].safeParse(call.data!.arguments);
      if (!input.success) {
        error(response, 400, id, -32602, '任务工具参数无效');
        return;
      }
      current();
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('任务工具已关闭'));
        revoked.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        // RPC IDs have no durable retry semantics. Only the host-owned operation
        // ID can confirm an earlier task mutation; this transport never retries.
        const result = await Promise.race([options.call(name, input.data), interrupted]);
        current();
        const text = JSON.stringify(result);
        if (text === undefined) throw new Error('任务工具结果无效');
        reply(response, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } finally {
        revoked.signal.removeEventListener('abort', abort);
      }
    } catch {
      try {
        current();
        error(response, 200, id, -32000, '任务工具结果未确认，请读取状态；不会自动重发');
      } catch {
        error(response, 403, id, -32000, '任务工具授权已失效');
      }
    } finally {
      if (key) activeIds.delete(key);
      if (counted) active--;
    }
  }
  const close = () =>
    (closeResult ??= (async () => {
      closed = true;
      revoked.abort();
      for (const response of responses) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    current();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('任务工具监听失败');
    origin = 'http://127.0.0.1:' + address.port;
    return { endpoint: { url: origin + '/mcp', token }, close };
  } catch {
    await close();
    throw new Error('无法创建本机任务工具连接');
  }
}
