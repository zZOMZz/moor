import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProcessRecovery } from '../src/desktop/recovery.cjs';
function fixture() {
  let now = 0,
    serial = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>(),
    children: any[] = [],
    states: any[] = [];
  const recovery = new ProcessRecovery({
    now: () => now,
    onState: (s: any) => states.push(s),
    launch: () => {
      const c = new EventEmitter() as any;
      c.signals = [];
      c.kill = (signal: string) => c.signals.push(signal);
      children.push(c);
      return c;
    },
    schedule: ((fn: () => void, delay: number) => {
      timers.set(++serial, { fn, delay });
      return serial;
    }) as any,
    cancel: ((id: number) => timers.delete(id)) as any,
  });
  return {
    recovery,
    children,
    states,
    timers,
    advance: (ms: number) => (now += ms),
    fire: () => {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      now += timer.delay;
      timer.fn();
    },
  };
}
test('unexpected exits recover with a bound, and manual recovery never kills a live host', () => {
  const f = fixture();
  f.recovery.start();
  f.recovery.start();
  assert.equal(f.children.length, 1);
  assert.equal(f.recovery.retry(), false);
  assert.deepEqual(f.children[0].signals, []);
  for (let i = 0; i < 3; i++) {
    f.children.at(-1).emit('close', 1);
    assert.equal(f.timers.size, 1);
    f.fire();
  }
  f.children.at(-1).emit('close', 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.states.at(-1).state, 'failed');
  assert.equal(f.children.length, 4);
  assert.equal(f.recovery.retry(), true);
  assert.equal(f.children.length, 5);
  f.recovery.stop();
  assert.deepEqual(f.children.at(-1).signals, ['SIGTERM']);
  f.children.at(-1).emit('close', 0);
  assert.equal(f.timers.size, 0);
});
test('another Lody instance is not terminated or retried automatically', () => {
  const f = fixture();
  f.recovery.start();
  f.children[0].emit('close', 3);
  assert.equal(f.states.at(-1).state, 'blocked');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.children[0].signals, []);
  f.recovery.retry();
  assert.equal(f.children.length, 2);
});
test('sustained readiness restores the retry budget; quitting cancels pending restarts', () => {
  const f = fixture();
  f.recovery.start();
  f.children[0].emit('close', 1);
  f.fire();
  f.recovery.ready();
  f.advance(60_000);
  f.children[1].emit('close', 1);
  assert.equal(f.states.at(-1).attempt, 1);
  f.recovery.stop();
  assert.equal(f.timers.size, 0);
});
