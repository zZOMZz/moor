import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { WebSocketServer } from 'ws';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createRequire as previewRequire } from 'node:module';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createPreviewRenderer } from '../src/runtime/preview-renderer';
import type { PreviewFrame, PreviewAction } from '../src/preview-protocol';

const workerPath = path.resolve('src/desktop/preview-renderer.cjs');
function nativeRenderer() {
  const packagedApp = process.env.MOOR_TEST_PACKAGED_APP;
  return createPreviewRenderer({
    workerPath:
      process.env.MOOR_TEST_PREVIEW_WORKER ||
      (packagedApp
        ? path.join(packagedApp, 'Contents/Resources/app/runtime/preview-renderer.cjs')
        : workerPath),
    ...(packagedApp ? { electronPath: path.join(packagedApp, 'Contents/MacOS/Electron') } : {}),
  });
}
const { createOriginProxy, serviceOrigin, canonicalPath } = previewRequire(import.meta.url)(
  workerPath,
) as {
  createOriginProxy(origin: string): Promise<{ address: string; close(): Promise<void> }>;
  serviceOrigin(value: string): URL;
  canonicalPath(value: string): string;
};
const scope = {
  workspaceId: 'synthetic-workspace',
  localProjectId: 'synthetic-project',
  sessionId: 'synthetic-session',
  previewVersion: 1 as const,
};
const binding = {
  previewId: 'synthetic-preview',
  origin: 'http://127.0.0.1:43210',
  startPath: '/',
  viewport: { width: 390, height: 844 },
};
const check = { assertCurrent() {} };
function frame(): PreviewFrame {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(390, 16);
  bytes.writeUInt32BE(844, 20);
  return {
    previewId: binding.previewId,
    frameId: 'synthetic-frame',
    documentId: 'synthetic-document',
    revision: 1,
    viewport: binding.viewport,
    path: '/',
    title: 'Synthetic',
    capturedAt: '2026-09-12T00:00:00Z',
    image: {
      mediaType: 'image/png',
      data: bytes.toString('base64'),
      byteLength: bytes.length,
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
type Message = Record<string, any>;
function syntheticTransport(handler?: (message: Message, reply: (value: unknown) => void) => void) {
  const commands: Message[] = [];
  let child!: EventEmitter & {
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    stdin: Writable;
    stdio: unknown[];
    kill(signal: string): boolean;
  };
  let environment: NodeJS.ProcessEnv | undefined;
  const spawn = (_executable: string, _args: string[], options: SpawnOptions) => {
    environment = options.env;
    const nonce = options.env!.MOOR_PREVIEW_NONCE;
    const output = new PassThrough();
    child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      stdin: new Writable(),
      stdio: [null, null, null, output] as unknown[],
      kill(signal: string) {
        child.killed = true;
        child.signalCode = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      },
    });
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const message = JSON.parse(String(chunk));
        commands.push(message);
        const reply = (result: unknown) =>
          output.write(JSON.stringify({ nonce, id: message.id, ok: true, result }) + '\n');
        if (handler) handler(message, reply);
        else
          reply(
            message.command === 'probe'
              ? { available: true }
              : message.command === 'prepare'
                ? { preparedId: 'synthetic-prepared' }
                : frame(),
          );
        done();
      },
    });
    queueMicrotask(() =>
      output.write(JSON.stringify({ nonce, ready: true, electron: '44.3.0' }) + '\n'),
    );
    return child as unknown as ChildProcess;
  };
  return {
    spawn,
    commands,
    get child() {
      return child;
    },
    get environment() {
      return environment;
    },
  };
}
function renderer(transport: ReturnType<typeof syntheticTransport>) {
  return createPreviewRenderer({
    spawn: transport.spawn,
    electronPath: process.execPath,
    workerPath,
  });
}

test('preview renderer opens a private process and validates PNG hash and dimensions', async () => {
  const transport = syntheticTransport();
  const driver = renderer(transport);
  try {
    assert.equal((await driver.open(binding, check)).image.version, frame().image.version);
    assert.equal(transport.environment?.NODE_OPTIONS, undefined);
    assert.equal(transport.environment?.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(transport.environment?.HTTPS_PROXY, undefined);
  } finally {
    await driver.closeAll();
  }
  assert.equal(transport.child.killed, true);
});
test('preview renderer refuses malformed image content from its private worker', async () => {
  const transport = syntheticTransport((_message, reply) => {
    const value = frame();
    value.image.version = 'sha256:' + 'a'.repeat(64);
    reply(value);
  });
  await assert.rejects(renderer(transport).open(binding, check));
  assert.equal(transport.child.killed, true);
});
test('close tombstones an open that has not arrived', async () => {
  const transport = syntheticTransport();
  const driver = renderer(transport);
  await driver.close(binding.previewId);
  await assert.rejects(driver.open(binding, check));
  assert.equal(transport.commands.length, 0);
});
test('preview capability probe is shared and cached across repeated option reads', async () => {
  const transport = syntheticTransport();
  const driver = renderer(transport);
  const values = await Promise.all(Array.from({ length: 30 }, () => driver.available()));
  assert.equal(
    values.every((value) => value.available),
    true,
  );
  assert.equal((await driver.available()).available, true);
  assert.equal(transport.commands.filter((v) => v.command === 'probe').length, 1);
});
test('close terminates a pending open and a late worker result cannot restore it', async () => {
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const transport = syntheticTransport((message) => {
    if (message.command === 'open') reached();
  });
  const driver = renderer(transport);
  const open = driver.open(binding, check);
  const rejected = assert.rejects(open);
  await waiting;
  await driver.close(binding.previewId);
  await rejected;
  assert.equal(transport.child.killed, true);
  await assert.rejects(driver.open(binding, check));
});
test('interaction rechecks host lease after preparation and never dispatches revoked scope', async () => {
  let valid = true;
  const transport = syntheticTransport((message, reply) => {
    if (message.command === 'prepare') {
      valid = false;
      reply({ preparedId: 'prepared' });
    } else reply(frame());
  });
  const driver = renderer(transport);
  await driver.open(binding, check);
  try {
    const request = {
      ...scope,
      clientId: 'client',
      operationId: 'operation',
      confirmed: true,
      action: 'reload',
      previewId: binding.previewId,
      frameId: frame().frameId,
    } as PreviewAction;
    await assert.rejects(
      driver.interact(request as Exclude<PreviewAction, { action: 'open' }>, {
        assertCurrent() {
          if (!valid) throw new Error('revoked');
        },
      }),
    );
    assert.deepEqual(
      transport.commands.map((v) => v.command),
      ['open', 'prepare'],
    );
  } finally {
    await driver.closeAll();
  }
});
test('interaction durable dispatch callback runs after preparation; rejection sends no input', async () => {
  const transport = syntheticTransport();
  const driver = renderer(transport);
  await driver.open(binding, check);
  try {
    const request = {
      ...scope,
      clientId: 'client',
      operationId: 'operation',
      confirmed: true,
      action: 'reload',
      previewId: binding.previewId,
      frameId: frame().frameId,
    } as const;
    await assert.rejects(
      driver.interact(request, {
        assertCurrent() {},
        beforeDispatch() {
          assert.equal(transport.commands.at(-1)?.command, 'prepare');
          throw new Error('receipt write failed');
        },
      }),
    );
    assert.deepEqual(
      transport.commands.map((v) => v.command),
      ['open', 'prepare'],
    );
  } finally {
    await driver.closeAll();
  }
});
test('preview origin and path validation prevents alternate hosts, credentials and escaping paths', () => {
  for (const value of [
    'https://127.0.0.1:8080',
    'http://localhost:8080',
    'http://127.0.0.2:8080',
    'http://user:secret@127.0.0.1:8080',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1:0',
  ])
    assert.throws(() => serviceOrigin(value));
  for (const value of ['//evil.invalid/', '/a/../b', '/%2e%2e/b', '/%5cother'])
    assert.throws(() => canonicalPath(value));
  assert.equal(canonicalPath('/%E4%B8%AD%E6%96%87?view=one'), '/%E4%B8%AD%E6%96%87?view=one');
});
async function proxyRequest(
  address: string,
  url: string,
  headers?: Record<string, string>,
  method = 'GET',
) {
  const [hostname, port] = address.split(':');
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname,
        port: Number(port),
        path: url,
        method,
        headers: { host: new URL(url).host, ...headers },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (value) => {
          text += value;
        });
        response.on('end', () => resolve({ status: response.statusCode!, text }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}
test('private preview gateway serves only the exact registered origin and strips proxy credentials', async () => {
  const seen: Record<string, unknown>[] = [];
  const good = createServer((req, res) => {
    seen.push(req.headers);
    res.end('synthetic allowed');
  });
  const bad = createServer((_req, res) => {
    assert.fail('unregistered server received request');
    res.end();
  });
  good.listen(0, '127.0.0.1');
  bad.listen(0, '127.0.0.1');
  await Promise.all([once(good, 'listening'), once(bad, 'listening')]);
  const origin = 'http://127.0.0.1:' + (good.address() as { port: number }).port;
  const other = 'http://127.0.0.1:' + (bad.address() as { port: number }).port;
  const gateway = await createOriginProxy(origin);
  try {
    assert.equal(
      (
        await proxyRequest(gateway.address, origin + '/ok', {
          'proxy-authorization': 'must-not-forward',
        })
      ).text,
      'synthetic allowed',
    );
    assert.equal(seen[0]['proxy-authorization'], undefined);
    assert.equal((await proxyRequest(gateway.address, other + '/bad')).status, 403);
    assert.equal(
      (await proxyRequest(gateway.address, origin + '/bad', { host: 'other.invalid' })).status,
      403,
    );
    assert.equal((await proxyRequest(gateway.address, origin + '/bad', {}, 'TRACE')).status, 403);
    assert.equal(seen.length, 1);
  } finally {
    await gateway.close();
    await Promise.all([
      new Promise<void>((r) => good.close(() => r())),
      new Promise<void>((r) => bad.close(() => r())),
    ]);
  }
});
test('private preview gateway refuses CONNECT and terminates all transports on close', async () => {
  const good = createServer((_req, res) => res.end('ok'));
  good.listen(0, '127.0.0.1');
  await once(good, 'listening');
  const origin = 'http://127.0.0.1:' + (good.address() as { port: number }).port;
  const gateway = await createOriginProxy(origin);
  try {
    const [host, port] = gateway.address.split(':');
    const result = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host,
        port: Number(port),
        method: 'CONNECT',
        path: '127.0.0.1:12345',
      });
      req.on('connect', (response, socket) => {
        socket.destroy();
        resolve(response.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(result, 403);
    await gateway.close();
    await assert.rejects(proxyRequest(gateway.address, origin + '/'));
  } finally {
    await gateway.close();
    await new Promise<void>((r) => good.close(() => r()));
  }
});

test(
  'real pinned Electron renders, locates, inputs, resizes and closes without another origin',
  { skip: process.env.MOOR_TEST_ELECTRON_PREVIEW !== '1' },
  async () => {
    let inputSeen!: (value: string) => void;
    const valueSeen = new Promise<string>((resolve) => {
      inputSeen = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/value?')) {
        inputSeen(new URL(req.url, 'http://test').searchParams.get('text')!);
        res.end('ok');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><style>body{margin:0}input{position:absolute;left:20px;top:30px;width:200px;height:30px;caret-color:transparent}</style><input aria-label="Synthetic input" oninput="fetch(\'/value?text=\'+encodeURIComponent(this.value))">',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const driver = nativeRenderer();
    const nativeBinding = {
      ...binding,
      origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    };
    try {
      assert.deepEqual(await driver.available(), { available: true });
      const opened = await driver.open(nativeBinding, check);
      assert.deepEqual(opened.viewport, binding.viewport);
      const element = await driver.locate(
        binding.previewId,
        opened.frameId,
        { x: 40, y: 45 },
        check,
      );
      assert.equal(element?.editable, true);
      const typed = await driver.interact(
        {
          ...scope,
          clientId: 'native-client',
          operationId: 'native-input',
          confirmed: true,
          action: 'input',
          previewId: binding.previewId,
          frameId: opened.frameId,
          elementId: element!.elementId,
          text: '中文输入',
          replace: true,
        },
        check,
      );
      assert.equal(await valueSeen, '中文输入');
      const stableTyped = await driver.capture(binding.previewId, check);
      assert.notEqual(
        typed.image.version,
        opened.image.version,
        'input receipt must not reuse the pre-input bitmap',
      );
      assert.equal(
        typed.image.version,
        stableTyped.image.version,
        'input receipt must contain the new painted value',
      );
      const resized = await driver.interact(
        {
          ...scope,
          clientId: 'native-client',
          operationId: 'native-resize',
          confirmed: true,
          action: 'resize',
          previewId: binding.previewId,
          frameId: stableTyped.frameId,
          viewport: { width: 800, height: 600 },
        },
        check,
      );
      assert.deepEqual(resized.viewport, { width: 800, height: 600 });
      await driver.close(binding.previewId);
      await assert.rejects(driver.capture(binding.previewId, check));
    } finally {
      await driver.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  'real renderer allows CSS animation but rejects identical DOM replacements',
  { skip: process.env.MOOR_TEST_ELECTRON_PREVIEW !== '1' },
  async () => {
    let events: ServerResponse | undefined;
    let ready!: () => void;
    const connected = new Promise<void>((r) => {
      ready = r;
    });
    let changed!: () => void;
    const replaced = new Promise<void>((r) => {
      changed = r;
    });
    let animated!: () => void;
    const animation = new Promise<void>((r) => {
      animated = r;
    });
    const server = createServer((req, res) => {
      if (req.url === '/events') {
        events = res;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': connected\n\n');
        ready();
        return;
      }
      if (req.url === '/changed') {
        changed();
        res.end('ok');
        return;
      }
      if (req.url === '/animated') {
        animated();
        res.end('ok');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><style>body{margin:0}button{position:absolute;left:20px;top:30px;width:200px;height:40px}.spinner{position:absolute;top:150px;width:50px;height:50px;background:red;animation:color 100ms infinite alternate}@keyframes color{to{background:blue}}</style><button>Same appearance</button><div class="spinner"></div><script>document.querySelector('.spinner').addEventListener('animationiteration',()=>fetch('/animated'),{once:true});new EventSource('/events').onmessage=()=>{const button=document.querySelector('button');button.replaceWith(button.cloneNode(true));fetch('/changed')}</script>`,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const driver = nativeRenderer();
    try {
      const opened = await driver.open(
        { ...binding, origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port },
        check,
      );
      await Promise.all([connected, animation]);
      const element = await driver.locate(
        binding.previewId,
        opened.frameId,
        { x: 40, y: 45 },
        check,
      );
      assert.equal(element?.tag, 'button');
      events!.write('data: replace\n\n');
      await replaced;
      let dispatched = 0;
      await assert.rejects(
        driver.interact(
          {
            ...scope,
            clientId: 'native-client',
            operationId: 'native-replaced',
            confirmed: true,
            action: 'click',
            previewId: binding.previewId,
            frameId: opened.frameId,
            elementId: element!.elementId,
          },
          {
            assertCurrent() {},
            beforeDispatch() {
              dispatched++;
            },
          },
        ),
      );
      assert.equal(dispatched, 0);
    } finally {
      await driver.closeAll();
      events?.end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  'real renderer confines HTTP WebSocket WebRTC and WebTransport to its fixed service',
  { skip: process.env.MOOR_TEST_ELECTRON_PREVIEW !== '1' },
  async () => {
    const hits = { tcp: 0, udp: 0 };
    const tcp = createTcpServer((socket) => {
      hits.tcp++;
      socket.on('error', () => {});
      socket.destroy();
    });
    tcp.listen(0, '127.0.0.1');
    await once(tcp, 'listening');
    const udp = createSocket('udp4');
    udp.on('message', () => hits.udp++);
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    const tcpPort = (tcp.address() as { port: number }).port,
      udpPort = udp.address().port;
    let complete!: (value: string[]) => void;
    const results = new Promise<string[]>((r) => {
      complete = r;
    });
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/results?')) {
        complete(JSON.parse(new URL(req.url, 'http://test').searchParams.get('value')!));
        res.end('ok');
        return;
      }
      if (req.url === '/allowed') {
        res.end('allowed');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><p>Network test</p><script>Promise.all([
      fetch('/allowed').then(r=>r.text()),
      fetch('http://127.0.0.1:${tcpPort}/bad').then(()=>'BAD',()=>'http:blocked'),
      new Promise(r=>{const w=new WebSocket('ws://'+location.host+'/ws');w.onmessage=e=>{r(e.data);w.close()};w.onerror=()=>r('websocket:FAILED')}),
      new WebTransport('https://127.0.0.1:${udpPort}/transport').ready.then(()=>'BAD',()=>'transport:blocked'),
      (async()=>{const p=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'},{urls:['turn:127.0.0.1:${tcpPort}?transport=tcp','turn:127.0.0.1:${udpPort}?transport=udp'],username:'synthetic',credential:'synthetic'}]});p.createDataChannel('test');const done=new Promise(r=>p.onicegatheringstatechange=()=>{if(p.iceGatheringState==='complete')r('rtc:complete')});await p.setLocalDescription(await p.createOffer());const result=await done;p.close();return result})()
    ]).then(value=>fetch('/results?value='+encodeURIComponent(JSON.stringify(value))));</script>`);
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => socket.send('websocket:allowed'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const driver = nativeRenderer();
    try {
      await driver.open(
        { ...binding, origin: 'http://127.0.0.1:' + (server.address() as { port: number }).port },
        check,
      );
      assert.deepEqual(await results, [
        'allowed',
        'http:blocked',
        'websocket:allowed',
        'transport:blocked',
        'rtc:complete',
      ]);
      assert.deepEqual(hits, { tcp: 0, udp: 0 });
    } finally {
      await driver.closeAll();
      wss.close();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => tcp.close(() => r())),
      ]);
      udp.close();
    }
  },
);

test('fixed service CONNECT only parses WebSocket and cannot carry HTTP TLS or STUN', async () => {
  let upstreamConnections = 0;
  const server = createServer((_req, res) => res.end('must not be reached'));
  server.on('connection', () => upstreamConnections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const authority = '127.0.0.1:' + (server.address() as { port: number }).port;
  const gateway = await createOriginProxy('http://' + authority);
  try {
    for (const payload of [
      Buffer.from(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`),
      Buffer.from('160301000401000000', 'hex'),
      Buffer.from('000100002112a442000000000000000000000000', 'hex'),
      Buffer.from(
        `GET /ws HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://evil.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    ]) {
      const [host, port] = gateway.address.split(':');
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          host,
          port: Number(port),
          method: 'CONNECT',
          path: authority,
          headers: { host: authority },
        });
        req.on('connect', (response, socket) => {
          assert.equal(response.statusCode, 200);
          socket.on('error', reject);
          socket.resume();
          socket.once('close', () => resolve());
          socket.end(payload);
        });
        req.on('error', reject);
        req.end();
      });
    }
    assert.equal(upstreamConnections, 0);
  } finally {
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
