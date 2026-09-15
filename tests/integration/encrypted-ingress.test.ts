import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as ws from 'ws';
import type { Writable } from 'node:stream';
import { EncryptedIngress, EncryptedIngressBudget } from '@moor/gateway/encrypted-ingress';
import type { EncryptedBridgeTimers } from '@moor/gateway/encrypted-bridge';

// Receiver is a public ws export, although @types/ws does not declare it.
const { Receiver } = ws as unknown as {
  Receiver: new (options: {
    isServer: boolean;
    allowSynchronousEvents: boolean;
    maxPayload: number;
  }) => Writable;
};
const frameOverhead = 256;
const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
type FrameOptions = {
  opcode?: number;
  fin?: boolean;
  masked?: boolean;
  rsv?: number;
  lengthCode?: 126 | 127;
};
function header(length: number | bigint, options: FrameOptions = {}) {
  const numeric = BigInt(length);
  const lengthCode =
    options.lengthCode ?? (numeric < 126n ? Number(numeric) : numeric < 65536n ? 126 : 127);
  const masked = options.masked ?? true;
  const extended = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
  const bytes = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  bytes[0] = ((options.fin ?? true) ? 0x80 : 0) | (options.rsv ?? 0) | (options.opcode ?? 1);
  bytes[1] = (masked ? 0x80 : 0) | lengthCode;
  if (lengthCode === 126) bytes.writeUInt16BE(Number(numeric), 2);
  if (lengthCode === 127) bytes.writeBigUInt64BE(numeric, 2);
  if (masked) mask.copy(bytes, 2 + extended);
  return bytes;
}
function frame(payload: string | Buffer, options: FrameOptions = {}) {
  const bytes = Buffer.from(payload);
  if (options.masked ?? true)
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4];
  return Buffer.concat([header(bytes.length, options), bytes]);
}
class Timers implements EncryptedBridgeTimers {
  readonly entries = new Map<object, { callback: () => void; milliseconds: number }>();
  readonly scheduled: { handle: object; callback: () => void; milliseconds: number }[] = [];
  set(callback: () => void, milliseconds: number) {
    const handle = {};
    this.entries.set(handle, { callback, milliseconds });
    this.scheduled.push({ handle, callback, milliseconds });
    return handle;
  }
  clear(handle: unknown) {
    this.entries.delete(handle as object);
  }
  fire(handle: object) {
    const entry = this.entries.get(handle);
    assert.ok(entry, 'the requested deadline must still be armed');
    this.entries.delete(handle);
    entry.callback();
  }
}
function fixture(
  t: TestContext,
  options: {
    budget?: EncryptedIngressBudget;
    maxBytes?: number;
    messageBytes?: () => number;
    maxFragments?: number;
    messageMs?: number;
    autoComplete?: boolean;
    onMessage?: (bytes: Buffer) => void;
  } = {},
) {
  const budget = options.budget ?? new EncryptedIngressBudget(options.maxBytes ?? 2 * 1024 * 1024);
  const timers = new Timers();
  const receiver = new Receiver({
    isServer: true,
    allowSynchronousEvents: true,
    maxPayload: 1024 * 1024,
  });
  const messages: string[] = [];
  const controls: { type: 'ping' | 'pong'; text: string; usedBytes: number }[] = [];
  const forwarded: { bytes: Buffer; backing: ArrayBufferLike }[] = [];
  const usedDuringMessage: number[] = [];
  const errors: Error[] = [];
  let failures = 0;
  let resolveError!: (error: Error) => void;
  const firstError = new Promise<Error>((resolve) => {
    resolveError = resolve;
  });
  const ingress = new EncryptedIngress({
    budget,
    messageBytes: options.messageBytes ?? (() => 1024 * 1024),
    timers,
    maxFragments: options.maxFragments,
    messageMs: options.messageMs,
    fail() {
      failures++;
    },
    forward(bytes) {
      forwarded.push({ bytes: Buffer.from(bytes), backing: bytes.buffer });
      receiver.write(bytes);
    },
  });
  receiver.on('message', (bytes: Buffer, binary: boolean) => {
    try {
      assert.equal(binary, false);
      messages.push(bytes.toString());
      usedDuringMessage.push(budget.usedBytes);
      options.onMessage?.(bytes);
    } finally {
      if (options.autoComplete !== false) ingress.completeMessage();
    }
  });
  for (const type of ['ping', 'pong'] as const)
    receiver.on(type, (bytes: Buffer) =>
      controls.push({ type, text: bytes.toString(), usedBytes: budget.usedBytes }),
    );
  receiver.on('error', (error: Error) => {
    errors.push(error);
    ingress.close();
    resolveError(error);
  });
  t.after(() => {
    ingress.close();
    receiver.destroy();
  });
  return {
    ingress,
    budget,
    timers,
    receiver,
    messages,
    controls,
    forwarded,
    usedDuringMessage,
    errors,
    firstError,
    failures: () => failures,
  };
}

test('ingress holds a complete message reservation until its consumer finishes', (t) => {
  const peer = fixture(t, { autoComplete: false });
  peer.ingress.receive(frame('encrypted-record'));
  assert.deepEqual(peer.messages, ['encrypted-record']);
  const expected = Buffer.byteLength('encrypted-record') + frameOverhead;
  assert.deepEqual(peer.usedDuringMessage, [expected]);
  assert.equal(peer.budget.usedBytes, expected);
  peer.ingress.completeMessage();
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
  peer.ingress.close();
  peer.ingress.close();
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('shared ingress budget rejects another connection from its declared header alone', (t) => {
  const budget = new EncryptedIngressBudget(500);
  const first = fixture(t, { budget });
  const second = fixture(t, { budget });
  first.ingress.receive(header(80));
  assert.equal(budget.usedBytes, 80 + frameOverhead);
  second.ingress.receive(header(80));
  assert.equal(second.failures(), 1);
  assert.equal(second.forwarded.length, 0, 'a rejected declaration must not reach Receiver');
  assert.equal(
    budget.usedBytes,
    80 + frameOverhead,
    'rejecting a peer must preserve the other reservation',
  );
  second.ingress.receive(frame('ignored'));
  second.ingress.close();
  assert.equal(second.failures(), 1);
  assert.equal(second.forwarded.length, 0);
  first.ingress.close();
  assert.equal(budget.usedBytes, 0);
  const third = fixture(t, { budget });
  third.ingress.receive(frame('available again'));
  assert.deepEqual(third.messages, ['available again']);
  assert.equal(budget.usedBytes, 0);
});

test('message size is rejected from a header without waiting for or forwarding its payload', (t) => {
  const peer = fixture(t, { messageBytes: () => 125 });
  const bytes = header(65536);
  for (const byte of bytes) peer.ingress.receive(Buffer.from([byte]));
  assert.equal(peer.failures(), 1);
  assert.equal(peer.forwarded.length, 0);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
});

test('fragments and interleaved control frames preserve message accounting until delivery', (t) => {
  const peer = fixture(t);
  peer.ingress.receive(frame('hello ', { fin: false }));
  const firstReservation = 6 + frameOverhead;
  assert.equal(peer.budget.usedBytes, firstReservation);
  assert.deepEqual(peer.messages, []);
  peer.ingress.receive(frame('probe', { opcode: 9 }));
  assert.equal(peer.budget.usedBytes, firstReservation);
  peer.ingress.receive(frame('ack', { opcode: 10 }));
  assert.equal(peer.budget.usedBytes, firstReservation);
  assert.deepEqual(
    peer.controls.map(({ type, text }) => ({ type, text })),
    [
      { type: 'ping', text: 'probe' },
      { type: 'pong', text: 'ack' },
    ],
  );
  assert.ok(peer.controls.every((control) => control.usedBytes >= firstReservation));
  peer.ingress.receive(frame('world', { opcode: 0 }));
  assert.deepEqual(peer.messages, ['hello world']);
  assert.deepEqual(peer.usedDuringMessage, [11 + 2 * frameOverhead]);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('all legal header lengths survive bytewise header and split payload delivery', async (t) => {
  for (const length of [1, 126, 65536])
    await t.test(`payload ${length}`, (t) => {
      const peer = fixture(t);
      const payload = 'x'.repeat(length);
      const bytes = frame(payload);
      const headerLength = header(length).length;
      for (let index = 0; index < headerLength; index++)
        peer.ingress.receive(bytes.subarray(index, index + 1));
      assert.equal(peer.budget.usedBytes, length + frameOverhead);
      assert.deepEqual(peer.messages, []);
      const middle = headerLength + Math.floor(length / 2);
      peer.ingress.receive(bytes.subarray(headerLength, middle));
      peer.ingress.receive(bytes.subarray(middle));
      assert.deepEqual(peer.messages, [payload]);
      assert.equal(peer.budget.usedBytes, 0);
      assert.equal(peer.failures(), 0);
    });
});

test('coalesced messages release synchronously and re-evaluate the current message allowance', (t) => {
  let allowance = 4;
  const peer = fixture(t, {
    maxBytes: 266,
    messageBytes: () => allowance,
    onMessage() {
      allowance = 10;
    },
  });
  peer.ingress.receive(Buffer.concat([frame('hi'), frame('0123456789')]));
  assert.deepEqual(peer.messages, ['hi', '0123456789']);
  assert.deepEqual(peer.usedDuringMessage, [258, 266]);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('cumulative message payload is bounded across fragments before the excess payload arrives', (t) => {
  const peer = fixture(t, { messageBytes: () => 4 });
  peer.ingress.receive(frame('ab', { fin: false }));
  const forwarded = peer.forwarded.length;
  peer.ingress.receive(header(3, { opcode: 0 }));
  assert.equal(peer.failures(), 1);
  assert.equal(peer.forwarded.length, forwarded);
  assert.deepEqual(peer.messages, []);
  assert.equal(peer.budget.usedBytes, 0);
});

test('invalid frame declarations fail without forwarding the invalid header', async (t) => {
  const invalid = [
    ['unmasked client frame', header(0, { masked: false })],
    ['binary frame', header(0, { opcode: 2 })],
    ['reserved data opcode', header(0, { opcode: 3 })],
    ['reserved control opcode', header(0, { opcode: 11 })],
    ['unexpected continuation', header(0, { opcode: 0 })],
    ['compressed frame', header(0, { rsv: 0x40 })],
    ['reserved bit two', header(0, { rsv: 0x20 })],
    ['reserved bit three', header(0, { rsv: 0x10 })],
    ['fragmented ping', header(0, { opcode: 9, fin: false })],
    ['oversized ping', header(126, { opcode: 9 })],
    ['single byte close body', header(1, { opcode: 8 })],
    ['nonminimal 16 bit length', header(1, { lengthCode: 126 })],
    ['nonminimal 64 bit length', header(126, { lengthCode: 127 })],
    ['unsafe 64 bit length', header(9007199254740992n)],
    ['64 bit length high bit', header(9223372036854775808n)],
  ] as const;
  for (const [name, bytes] of invalid)
    await t.test(name, (t) => {
      const peer = fixture(t);
      peer.ingress.receive(bytes);
      assert.equal(peer.failures(), 1);
      assert.equal(peer.forwarded.length, 0);
      assert.equal(peer.budget.usedBytes, 0);
      assert.equal(peer.timers.entries.size, 0);
      peer.ingress.receive(frame('after rejection'));
      assert.equal(peer.failures(), 1);
      assert.deepEqual(peer.messages, []);
    });
});

test('a new text frame cannot replace an unfinished fragmented message', (t) => {
  const peer = fixture(t);
  peer.ingress.receive(frame('first', { fin: false }));
  const forwarded = peer.forwarded.length;
  peer.ingress.receive(header(1));
  assert.equal(peer.failures(), 1);
  assert.equal(peer.forwarded.length, forwarded);
  assert.equal(peer.budget.usedBytes, 0);
  assert.deepEqual(peer.messages, []);
});

test('configured and default fragment limits count empty continuations', async (t) => {
  for (const limit of [3, 1024])
    await t.test(`${limit} fragments`, (t) => {
      const peer = fixture(t, { maxFragments: limit === 3 ? limit : undefined });
      peer.ingress.receive(frame('', { fin: false }));
      for (let index = 1; index < limit; index++)
        peer.ingress.receive(frame('', { fin: false, opcode: 0 }));
      assert.equal(peer.failures(), 0);
      assert.equal(peer.budget.usedBytes, limit * frameOverhead);
      const forwarded = peer.forwarded.length;
      peer.ingress.receive(header(0, { opcode: 0 }));
      assert.equal(peer.failures(), 1);
      assert.equal(peer.forwarded.length, forwarded);
      assert.equal(peer.budget.usedBytes, 0);
      assert.deepEqual(peer.messages, []);
    });
});

test('a deadline starts with the first header byte and closes incomplete input', (t) => {
  const peer = fixture(t);
  peer.ingress.receive(Buffer.alloc(0));
  assert.equal(peer.timers.scheduled.length, 0);
  peer.ingress.receive(Buffer.from([0x81]));
  assert.equal(peer.timers.scheduled.length, 1);
  const deadline = peer.timers.scheduled[0];
  assert.equal(deadline.milliseconds, 30000);
  peer.timers.fire(deadline.handle);
  assert.equal(peer.failures(), 1);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
  peer.ingress.receive(frame('too late'));
  deadline.callback();
  assert.equal(peer.failures(), 1);
  assert.deepEqual(peer.messages, []);
});

test('control frames and continuations do not renew a message deadline', (t) => {
  const peer = fixture(t, { messageMs: 73 });
  peer.ingress.receive(frame('begin', { fin: false }));
  assert.equal(peer.timers.scheduled.length, 1);
  const deadline = peer.timers.scheduled[0];
  assert.equal(deadline.milliseconds, 73);
  peer.ingress.receive(frame('ping', { opcode: 9 }));
  peer.ingress.receive(frame('pong', { opcode: 10 }));
  peer.ingress.receive(frame('middle', { fin: false, opcode: 0 }));
  assert.equal(peer.timers.scheduled.length, 1);
  assert.ok(peer.timers.entries.has(deadline.handle));
  peer.timers.fire(deadline.handle);
  assert.equal(peer.failures(), 1);
  assert.equal(peer.budget.usedBytes, 0);
  assert.deepEqual(peer.messages, []);
});

test('completed messages cancel their deadline and later messages get a fresh deadline', (t) => {
  const peer = fixture(t);
  peer.ingress.receive(frame('done'));
  assert.equal(peer.timers.entries.size, 0);
  const old = peer.timers.scheduled[0];
  peer.ingress.receive(header(10));
  assert.equal(peer.timers.entries.size, 1);
  const next = peer.timers.scheduled[1];
  assert.notEqual(next.handle, old.handle);
  old.callback();
  assert.equal(peer.failures(), 0, 'a cleared stale callback cannot fail a later message');
  assert.equal(peer.budget.usedBytes, 10 + frameOverhead);
  peer.ingress.close();
  assert.equal(peer.timers.entries.size, 0);
  assert.equal(peer.budget.usedBytes, 0);
  next.callback();
  assert.equal(peer.failures(), 0);
});

test('Receiver UTF-8 errors release all reservations when the connection closes', async (t) => {
  const peer = fixture(t);
  peer.ingress.receive(frame(Buffer.from([0xc3]), { fin: false }));
  assert.equal(peer.budget.usedBytes, 1 + frameOverhead);
  peer.ingress.receive(frame(Buffer.from([0x28]), { opcode: 0 }));
  const error = await peer.firstError;
  assert.match(error.message, /UTF-8/i);
  assert.deepEqual(peer.messages, []);
  assert.equal(peer.errors.length, 1);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
});

test('partial headers and forwarded payloads do not retain or alias large input backing stores', (t) => {
  const peer = fixture(t);
  const wire = frame('isolated');
  const firstBacking = Buffer.alloc(1024 * 1024, 0xee);
  wire.subarray(0, 1).copy(firstBacking, 400);
  peer.ingress.receive(firstBacking.subarray(400, 401));
  firstBacking.fill(0);
  const secondBacking = Buffer.alloc(1024 * 1024, 0xee);
  wire.subarray(1, wire.length - 1).copy(secondBacking, 900);
  peer.ingress.receive(secondBacking.subarray(900, 900 + wire.length - 2));
  assert.deepEqual(peer.messages, []);
  assert.ok(
    peer.forwarded.every(
      (item) => item.backing !== firstBacking.buffer && item.backing !== secondBacking.buffer,
    ),
  );
  secondBacking.fill(0);
  peer.ingress.receive(wire.subarray(-1));
  assert.deepEqual(peer.messages, ['isolated']);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('standalone control frames reserve their body until fully received and release it afterwards', (t) => {
  const peer = fixture(t);
  const wire = frame('p'.repeat(125), { opcode: 9 });
  peer.ingress.receive(wire.subarray(0, 6));
  assert.equal(peer.budget.usedBytes, 125 + frameOverhead);
  assert.equal(peer.timers.entries.size, 1);
  assert.equal(peer.controls.length, 0);
  peer.ingress.receive(wire.subarray(6));
  assert.equal(peer.controls.length, 1);
  assert.equal(peer.controls[0].text, 'p'.repeat(125));
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
  assert.equal(peer.failures(), 0);
});

test('legal close frames stop trailing input and connection close releases unfinished fragments', (t) => {
  const peer = fixture(t);
  const closed: { code: number; reason: string }[] = [];
  peer.receiver.on('conclude', (code: number, reason: Buffer) => {
    closed.push({ code, reason: reason.toString() });
    peer.ingress.close();
  });
  peer.ingress.receive(frame('unfinished', { fin: false }));
  const closeBody = Buffer.alloc(5);
  closeBody.writeUInt16BE(1000);
  closeBody.write('bye', 2);
  peer.ingress.receive(Buffer.concat([frame(closeBody, { opcode: 8 }), frame('must not run')]));
  assert.deepEqual(closed, [{ code: 1000, reason: 'bye' }]);
  assert.deepEqual(peer.messages, []);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.timers.entries.size, 0);
  assert.equal(peer.failures(), 0);
});

test('UTF-8 code points can span text continuation frames', (t) => {
  const peer = fixture(t);
  const bytes = Buffer.from('A😀Z');
  peer.ingress.receive(frame(bytes.subarray(0, 3), { fin: false }));
  peer.ingress.receive(frame(bytes.subarray(3), { opcode: 0 }));
  assert.deepEqual(peer.messages, ['A😀Z']);
  assert.deepEqual(peer.usedDuringMessage, [bytes.length + 2 * frameOverhead]);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('fragment accounting resets only after the completed message has been consumed', (t) => {
  const peer = fixture(t, { maxFragments: 2 });
  peer.ingress.receive(
    Buffer.concat([
      frame('first ', { fin: false }),
      frame('message', { opcode: 0 }),
      frame('second ', { fin: false }),
      frame('message', { opcode: 0 }),
    ]),
  );
  assert.deepEqual(peer.messages, ['first message', 'second message']);
  assert.deepEqual(peer.usedDuringMessage, [13 + 2 * frameOverhead, 14 + 2 * frameOverhead]);
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});

test('bytewise TCP delivery keeps retained payload segments bounded by payload size', (t) => {
  const peer = fixture(t);
  const payload = 'x'.repeat(65536 + 31);
  const wire = frame(payload);
  const headerLength = header(payload.length).length;
  peer.ingress.receive(wire.subarray(0, headerLength));
  assert.equal(peer.budget.usedBytes, payload.length + frameOverhead);
  for (let index = headerLength; index < wire.length - 1; index++)
    peer.ingress.receive(wire.subarray(index, index + 1));
  assert.deepEqual(peer.messages, []);
  assert.equal(peer.budget.usedBytes, payload.length + frameOverhead);
  assert.ok(
    peer.forwarded.length <= 3,
    'one header and at most two bounded payload blocks, regardless of TCP chunk count',
  );
  peer.ingress.receive(wire.subarray(-1));
  assert.deepEqual(peer.messages, [payload]);
  assert.ok(peer.forwarded.length <= 3);
  assert.ok(peer.forwarded.every((item) => item.backing !== wire.buffer));
  assert.equal(peer.budget.usedBytes, 0);
  assert.equal(peer.failures(), 0);
});
