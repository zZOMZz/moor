import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, ServerResponse } from 'node:http';
import { createTaskMcp, type TaskMcp, type TaskMcpOptions } from '../src/runtime/task-mcp';
import { TASK_LIMITS, taskToolDefinitions } from '../src/task-protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(
  t: { after(fn: () => unknown): void },
  overrides: Partial<TaskMcpOptions> = {},
) {
  const calls: unknown[] = [];
  let valid = true;
  const mcp = await createTaskMcp({
    current: () => {
      if (!valid) throw new Error('private-current-error');
    },
    call: async (name, args) => {
      calls.push({ name, args });
      return { confirmed: true };
    },
    ...overrides,
  });
  t.after(() => mcp.close());
  let sequence = 0;
  const rpc = (method: string, params?: unknown, id: string | number = ++sequence) =>
    send(mcp, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const initialize = async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'synthetic', version: '1' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.result.protocolVersion, '2025-11-25');
    assert.equal(
      (await send(mcp, { jsonrpc: '2.0', method: 'notifications/initialized' })).status,
      202,
    );
  };
  return {
    mcp,
    rpc,
    initialize,
    calls,
    revoke: () => {
      valid = false;
    },
  };
}
async function send(
  mcp: TaskMcp,
  body: unknown,
  options: { headers?: Record<string, string>; path?: string; method?: string; raw?: Buffer } = {},
) {
  const bytes = options.raw ?? Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    let result: { status: number; json: any; text: string } | undefined;
    let failure: Error | undefined;
    const request = httpRequest(
      new URL(options.path ?? '/mcp', mcp.endpoint.url),
      {
        method: options.method ?? 'POST',
        agent: false,
        headers: {
          Authorization: 'Bearer ' + mcp.endpoint.token,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
          ...options.headers,
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on('data', (part) => parts.push(part));
        response.on('error', (error) => {
          failure = error;
          request.destroy();
        });
        response.on('end', () => {
          try {
            const text = Buffer.concat(parts).toString('utf8');
            result = {
              status: response.statusCode!,
              json: text ? JSON.parse(text) : undefined,
              text,
            };
          } catch (error) {
            failure = error as Error;
            request.destroy();
          }
        });
      },
    );
    request.on('error', (error) => {
      failure = error;
    });
    request.once('close', () => {
      // An early HTTP rejection can finish while the upload is still pending.
      if (result) resolve(result);
      else if (failure) reject(failure);
      else reject(new Error('synthetic HTTP transport closed without a complete response'));
    });
    request.end(bytes);
  });
}
const createArgs = { grantId: 'grant', taskId: 'task', operationId: 'operation' };

test('task MCP negotiates JSON-only Streamable HTTP and exposes exactly five typed tools', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc('tools/list')).status, 409);
  await f.initialize();
  assert.deepEqual((await f.rpc('tools/list')).json.result.tools, taskToolDefinitions);
  assert.equal(f.calls.length, 0);
  const result = await f.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.json.result.content[0].text), { confirmed: true });
  assert.deepEqual(f.calls, [{ name: 'moor_task_create', args: createArgs }]);
  assert.equal((await send(f.mcp, {}, { method: 'GET' })).status, 405);
  assert.equal((await send(f.mcp, {}, { method: 'DELETE' })).status, 405);
});

test('task MCP rejects foreign origins, bearer tokens, hosts, paths and transport headers before business calls', async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'moor_task_create', arguments: createArgs },
  };
  for (const headers of [
    { Authorization: 'Bearer wrong' },
    { Origin: 'https://attacker.invalid' },
    { Host: 'attacker.invalid' },
    { Cookie: 'secret' },
    { 'Content-Encoding': 'gzip' },
    { 'Proxy-Authorization': 'secret' },
    { 'Mcp-Session-Id': 'foreign' },
  ] as Record<string, string>[])
    assert.equal((await send(f.mcp, body, { headers })).status, 403);
  for (const path of ['/mcp?url=http://localhost', '/mcp/', '/anything'])
    assert.equal((await send(f.mcp, body, { path })).status, 404);
  assert.equal(
    (await send(f.mcp, body, { headers: { 'Content-Type': 'text/plain' } })).status,
    415,
  );
  assert.equal((await send(f.mcp, body, { headers: { Accept: 'application/json' } })).status, 415);
  assert.equal(
    (await send(f.mcp, body, { headers: { 'Mcp-Protocol-Version': '2099-01-01' } })).status,
    400,
  );
  assert.equal(f.calls.length, 0);
});

test('task MCP rejects batches, invalid UTF-8, unknown tools, arbitrary arguments and oversized requests', async (t) => {
  const f = await fixture(t);
  await f.initialize();
  for (const body of [
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    { jsonrpc: '2.0', id: 1, method: 'tools/list', extra: true },
  ])
    assert.equal((await send(f.mcp, body)).status, 400);
  assert.equal((await send(f.mcp, {}, { raw: Buffer.from([0xff]) })).status, 400);
  assert.equal((await f.rpc('resources/read', { uri: 'file:///secret' })).json.error.code, -32601);
  for (const [name, args] of [
    ['arbitrary_shell', createArgs],
    ['__proto__', createArgs],
    ['moor_task_create', { ...createArgs, command: 'whoami' }],
    [
      'moor_task_wait',
      { grantId: 'grant', taskId: 'task', expectedUserTurnId: 'turn', timeoutMs: 20001 },
    ],
  ])
    assert.equal((await f.rpc('tools/call', { name, arguments: args })).status, 400);
  assert.equal(
    (await send(f.mcp, {}, { raw: Buffer.alloc(TASK_LIMITS.requestBytes + 1, 32) })).status,
    413,
  );
  assert.equal(f.calls.length, 0);
});

test('late authorization changes suppress successful and failed tool results without exposing private errors', async (t) => {
  for (const failing of [false, true]) {
    const entered = deferred<void>(),
      result = deferred<unknown>();
    const f = await fixture(t, {
      call: async () => {
        entered.resolve();
        const value = await result.promise;
        if (failing) throw new Error('private-token-body');
        return value;
      },
    });
    await f.initialize();
    const pending = f.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs });
    await entered.promise;
    f.revoke();
    result.resolve({ privateBody: 'hidden' });
    const response = await pending;
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.text, /private|hidden/);
    assert.equal((await f.rpc('tools/list')).status, 403);
  }
});

test('task MCP has bounded concurrency, rejects duplicate in-flight RPC IDs and never retries callbacks', async (t) => {
  let count = 0;
  const entered = deferred<void>(),
    finish = deferred<unknown>();
  const f = await fixture(t, {
    call: async () => {
      if (++count === 4) entered.resolve();
      return finish.promise;
    },
  });
  await f.initialize();
  const requests = Array.from({ length: 4 }, (_, index) =>
    f.rpc(
      'tools/call',
      { name: 'moor_task_create', arguments: { ...createArgs, operationId: 'op-' + index } },
      'call-' + index,
    ),
  );
  await entered.promise;
  assert.equal((await f.rpc('tools/list')).status, 429);
  assert.equal(count, 4);
  finish.resolve({ ok: true });
  await Promise.all(requests);
  const first = deferred<void>(),
    release = deferred<void>();
  const g = await fixture(t, {
    call: async () => {
      first.resolve();
      await release.promise;
      throw new Error('private-secret');
    },
  });
  await g.initialize();
  const pending = g.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs }, 'same');
  await first.promise;
  assert.equal(
    (await g.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs }, 'same')).status,
    409,
  );
  release.resolve();
  const response = await pending;
  assert.doesNotMatch(response.text, /private-secret/);
  assert.equal(response.json.error.code, -32000);
});

test('closing tombstones pending requests immediately without waiting for business callbacks', async (t) => {
  const entered = deferred<void>();
  const f = await fixture(t, {
    call: async () => {
      entered.resolve();
      return new Promise(() => {});
    },
  });
  await f.initialize();
  const pending = f.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs });
  const failed = assert.rejects(pending);
  await entered.promise;
  await f.mcp.close();
  await failed;
  await assert.rejects(f.rpc('tools/list'));
  await f.mcp.close();
});

test('response limits and callback errors return fixed errors, and revoked opens do not leave listeners', async (t) => {
  const f = await fixture(t, {
    call: async () => ({ body: 'a'.repeat(TASK_LIMITS.responseBytes) }),
  });
  await f.initialize();
  const result = await f.rpc('tools/call', { name: 'moor_task_create', arguments: createArgs });
  assert.equal(result.json.error.code, -32000);
  assert.ok(result.text.length < 500);
  let checks = 0;
  await assert.rejects(
    createTaskMcp({
      current: () => {
        throw new Error('private-current');
      },
      call: async () => ({}),
    }),
    /任务工具授权已失效，未创建连接/,
  );
  await assert.rejects(
    createTaskMcp({
      current: () => {
        if (++checks === 2) throw new Error('private');
      },
      call: async () => ({}),
    }),
    /无法创建本机任务工具连接/,
  );
});

test("independent parent endpoints cannot reuse each other's bearer capability", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  await second.initialize();
  assert.notEqual(first.mcp.endpoint.url, second.mcp.endpoint.url);
  assert.notEqual(first.mcp.endpoint.token, second.mcp.endpoint.token);
  const result = await send(
    second.mcp,
    {
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'moor_task_create', arguments: createArgs },
    },
    { headers: { Authorization: 'Bearer ' + first.mcp.endpoint.token } },
  );
  assert.equal(result.status, 403);
  assert.equal(second.calls.length, 0);
  await first.mcp.close();
  assert.equal((await second.rpc('tools/list')).status, 200);
});

test('an asynchronous broken pipe while rejecting an oversized body closes only that transport', async (t) => {
  const f = await fixture(t);
  await f.initialize();
  const originalEnd = ServerResponse.prototype.end;
  const injected = deferred<void>();
  const transports: ServerResponse[] = [];
  t.mock.method(
    ServerResponse.prototype,
    'end',
    function (this: ServerResponse, ...args: Parameters<ServerResponse['end']>) {
      if (this.statusCode !== 413) return originalEnd.apply(this, args);
      transports.push(this);
      queueMicrotask(() => {
        try {
          // A socket write can fail after handle() has already replied and returned.
          this.emit('error', Object.assign(new Error('synthetic write EPIPE'), { code: 'EPIPE' }));
          assert.equal(this.destroyed, true);
          assert.equal(this.req.destroyed, true);
        } finally {
          this.destroy();
          injected.resolve();
        }
      });
      return this;
    },
  );
  await assert.rejects(send(f.mcp, {}, { raw: Buffer.alloc(TASK_LIMITS.requestBytes + 1, 32) }));
  await injected.promise;
  assert.equal(transports.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rpc('tools/list')).status, 200);
  assert.equal(f.calls.length, 0);
});
