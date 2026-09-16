import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { WorkspaceEvents } from '../../apps/desktop/src/main/workspace-events';

test('native invalidation feed is scoped, reconnects and closes with its authority', () => {
  const sockets: (EventEmitter & { terminate(): void })[] = [],
    notices: unknown[] = [];
  const timers = new Map<number, () => void>();
  let current = true;
  const stream = new WorkspaceEvents({
    origin: 'https://relay.synthetic.invalid',
    cookie: 'personal=SYNTHETIC_COOKIE',
    current: () => {
      if (!current) throw Error('Revoked');
    },
    changed: (value) => notices.push(value),
    schedule: (ms, fn) => {
      timers.set(ms, fn);
      return () => {
        timers.delete(ms);
      };
    },
    socket: (url, options) => {
      assert.equal(url.href, 'wss://relay.synthetic.invalid/events');
      assert.deepEqual(options.headers, {
        Origin: 'https://relay.synthetic.invalid',
        Cookie: 'personal=SYNTHETIC_COOKIE',
      });
      assert.equal(options.followRedirects, false);
      assert.equal(options.maxPayload, 4096);
      const emitter = new EventEmitter();
      const socket = Object.assign(emitter, {
        terminate() {
          emitter.emit('close');
        },
      });
      sockets.push(socket);
      return socket as unknown as Pick<WebSocket, 'on' | 'terminate'>;
    },
  });
  const emit = (value: unknown) =>
    sockets.at(-1)!.emit('message', Buffer.from(JSON.stringify(value)), false);
  sockets[0]!.emit('open');
  emit({
    type: 'changed',
    deviceId: 'device',
    workspaceId: 'workspace',
    room: { scope: 'doc', docId: 'session' },
    body: 'SYNTHETIC_BODY',
  });
  assert.deepEqual(notices, [
    { kind: 'connected' },
    { kind: 'changed', deviceId: 'device', workspaceId: 'workspace', sessionId: 'session' },
  ]);
  emit({ type: 'changed', deviceId: 'device', room: { scope: 'attention', docId: 'session' } });
  emit({ type: 'changed', deviceId: '', body: 'invalid' });
  emit({ type: 'changed', deviceId: 'device', body: 'x'.repeat(5000) });
  assert.equal(notices.length, 2);
  sockets[0]!.emit('close');
  assert.equal(timers.size, 1);
  const reconnect = timers.get(1000)!;
  timers.delete(1000);
  reconnect();
  sockets[1]!.emit('open');
  sockets[0]!.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'changed', deviceId: 'stale' })),
    false,
  );
  assert.equal(notices.length, 4);
  current = false;
  emit({ type: 'changed', deviceId: 'device' });
  assert.equal(notices.length, 4);
  assert.equal(timers.size, 0);
  stream.close();
});

test('closing a disconnected feed cancels its pending reconnect', () => {
  let callback: (() => void) | undefined;
  const socket = Object.assign(new EventEmitter(), { terminate() {} });
  const stream = new WorkspaceEvents({
    origin: 'http://127.0.0.1:5555',
    cookie: 'synthetic',
    current() {},
    changed() {},
    socket: () => socket as unknown as Pick<WebSocket, 'on' | 'terminate'>,
    schedule: (_ms, fn) => {
      callback = fn;
      return () => {
        callback = undefined;
      };
    },
  });
  socket.emit('close');
  assert(callback);
  stream.close();
  assert.equal(callback, undefined);
});
