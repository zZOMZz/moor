import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMetrics } from '../src/features/performance/performance-metrics';

test('frame measurements need two foreground timestamps and estimate FPS from elapsed time', () => {
  const metrics = new PerformanceMetrics();
  const empty = metrics.snapshot();
  assert.deepEqual(empty, {
    fps: null,
    frameP95Ms: null,
    frameMaxMs: null,
    stallCount: 0,
    stallTotalMs: 0,
    stallMaxMs: null,
    inputP95Ms: null,
    inputSamples: 0,
    streamP95Ms: null,
    streamSamples: 0,
  });
  metrics.frame(0);
  assert.deepEqual(metrics.snapshot(), empty);
  metrics.frame(10);
  metrics.frame(30);
  const measured = metrics.snapshot();
  assert.equal(measured.fps, 1000 / 15);
  assert.equal(measured.frameP95Ms, 20);
  assert.equal(measured.frameMaxMs, 20);
  assert.equal(measured.stallCount, 0);
});

test('stall threshold is strict and cumulative time includes the whole foreground interval', () => {
  const metrics = new PerformanceMetrics();
  metrics.frame(0);
  metrics.frame(100);
  assert.equal(metrics.snapshot().stallCount, 0);
  metrics.frame(201);
  metrics.frame(451);
  const measured = metrics.snapshot();
  assert.equal(measured.stallCount, 2);
  assert.equal(measured.stallTotalMs, 351);
  assert.equal(measured.stallMaxMs, 250);
  assert.equal(measured.frameMaxMs, 250);
});

test('suspending excludes a background gap without deleting collected samples', () => {
  const metrics = new PerformanceMetrics();
  metrics.frame(0);
  metrics.frame(16);
  metrics.latency('input', 12);
  const before = metrics.snapshot();
  metrics.suspend();
  metrics.frame(60_000);
  assert.deepEqual(metrics.snapshot(), before);
  metrics.frame(60_020);
  assert.equal(metrics.snapshot().fps, 1000 / 18);
  assert.equal(metrics.snapshot().frameMaxMs, 20);
  assert.equal(metrics.snapshot().stallCount, 0);
  assert.equal(metrics.snapshot().inputSamples, 1);
});

test('reset clears all statistics and starts a fresh frame baseline', () => {
  const metrics = new PerformanceMetrics();
  metrics.frame(0);
  metrics.frame(500);
  metrics.latency('input', 42);
  metrics.latency('stream', 90);
  metrics.reset();
  assert.deepEqual(metrics.snapshot(), new PerformanceMetrics().snapshot());
  metrics.frame(100_000);
  assert.equal(metrics.snapshot().fps, null);
  metrics.frame(100_010);
  assert.equal(metrics.snapshot().fps, 100);
  assert.equal(metrics.snapshot().stallCount, 0);
});

test('old frame stalls leave the 120-interval window but remain in reset-to-now totals', () => {
  const metrics = new PerformanceMetrics();
  metrics.frame(0);
  metrics.frame(500);
  for (let frame = 1; frame <= 119; frame++) metrics.frame(500 + frame * 16);
  assert.equal(metrics.snapshot().frameMaxMs, 500);
  metrics.frame(500 + 120 * 16);
  const measured = metrics.snapshot();
  assert.equal(measured.fps, 62.5);
  assert.equal(measured.frameP95Ms, 16);
  assert.equal(measured.frameMaxMs, 16);
  assert.equal(measured.stallCount, 1);
  assert.equal(measured.stallTotalMs, 500);
  assert.equal(measured.stallMaxMs, 500);
});

test('latency windows remain independent, bounded and include zero-duration measurements', () => {
  const metrics = new PerformanceMetrics();
  metrics.latency('stream', 0);
  for (let sample = 0; sample < 200; sample++) metrics.latency('input', 500);
  for (let sample = 0; sample < 200; sample++) metrics.latency('input', 20);
  let measured = metrics.snapshot();
  assert.equal(measured.inputSamples, 200);
  assert.equal(measured.inputP95Ms, 20);
  assert.equal(measured.streamSamples, 1);
  assert.equal(measured.streamP95Ms, 0);
  for (let sample = 0; sample < 200; sample++) metrics.latency('stream', 7);
  measured = metrics.snapshot();
  assert.equal(measured.streamSamples, 200);
  assert.equal(measured.streamP95Ms, 7);
  assert.equal(measured.inputP95Ms, 20);
});

test('p95 uses observed nearest-rank values without mutating collection order', () => {
  const metrics = new PerformanceMetrics();
  for (const duration of [20, ...Array.from({ length: 19 }, (_, index) => index + 1)])
    metrics.latency('input', duration);
  assert.equal(metrics.snapshot().inputP95Ms, 19);
  assert.equal(metrics.snapshot().inputP95Ms, 19);
  // The earliest large sample must still be evicted first after a snapshot sorts its copy.
  for (let sample = 0; sample < 180; sample++) metrics.latency('input', 0);
  metrics.latency('input', 0);
  assert.equal(metrics.snapshot().inputP95Ms, 9);
});

test('invalid measurements cannot poison later samples or move the frame baseline', () => {
  const metrics = new PerformanceMetrics();
  for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    metrics.frame(invalid);
    metrics.latency('input', invalid);
    metrics.latency('stream', invalid);
  }
  assert.deepEqual(metrics.snapshot(), new PerformanceMetrics().snapshot());
  metrics.frame(10);
  metrics.frame(10);
  metrics.frame(5);
  metrics.frame(NaN);
  metrics.frame(30);
  metrics.latency('input', 0);
  const measured = metrics.snapshot();
  assert.equal(measured.fps, 50);
  assert.equal(measured.frameMaxMs, 20);
  assert.equal(measured.inputP95Ms, 0);
  assert.equal(measured.inputSamples, 1);
  assert.equal(measured.streamSamples, 0);
});
