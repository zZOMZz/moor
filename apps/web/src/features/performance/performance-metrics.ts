export type PerformanceSnapshot = {
  fps: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  stallCount: number;
  stallTotalMs: number;
  stallMaxMs: number | null;
  inputP95Ms: number | null;
  inputSamples: number;
  streamP95Ms: number | null;
  streamSamples: number;
};

const valid = (value: number) => Number.isFinite(value) && value >= 0;

function record(samples: number[], value: number, limit: number) {
  samples.push(value);
  if (samples.length > limit) samples.shift();
}

/** Nearest-rank percentile: the smallest observed value covering at least 95% of samples. */
function p95(samples: readonly number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

/**
 * Pure, device-local measurements. Call frame only for foreground animation frames;
 * suspend before a hidden interval. Frame statistics retain 120 positive intervals,
 * while input/stream statistics retain 200 durations each (including zero).
 * FPS is 1000 / mean frame interval. A stall is one foreground interval >100 ms;
 * count, total and maximum span all stalls since reset, and total sums full intervals,
 * not merely their excess over 100 ms. Snapshot sample counts describe each window.
 */
export class PerformanceMetrics {
  #lastFrame: number | undefined;
  #frames: number[] = [];
  #input: number[] = [];
  #stream: number[] = [];
  #stallCount = 0;
  #stallTotalMs = 0;
  #stallMaxMs: number | null = null;

  /** Invalid, duplicate or backwards timestamps leave the previous frame unchanged. */
  frame(now: number) {
    if (!valid(now)) return;
    const previous = this.#lastFrame;
    if (previous !== undefined && now <= previous) return;
    this.#lastFrame = now;
    if (previous === undefined) return;
    const interval = now - previous;
    record(this.#frames, interval, 120);
    if (interval > 100) {
      this.#stallCount++;
      this.#stallTotalMs += interval;
      this.#stallMaxMs = Math.max(this.#stallMaxMs ?? 0, interval);
    }
  }

  /** Preserve collected measurements but require a new foreground baseline. */
  suspend() {
    this.#lastFrame = undefined;
  }

  reset() {
    this.suspend();
    this.#frames = [];
    this.#input = [];
    this.#stream = [];
    this.#stallCount = 0;
    this.#stallTotalMs = 0;
    this.#stallMaxMs = null;
  }

  latency(kind: 'input' | 'stream', durationMs: number) {
    if (!valid(durationMs)) return;
    if (kind === 'input') record(this.#input, durationMs, 200);
    else if (kind === 'stream') record(this.#stream, durationMs, 200);
  }

  snapshot(): PerformanceSnapshot {
    const meanFrameMs = this.#frames.length
      ? this.#frames.reduce((total, interval) => total + interval, 0) / this.#frames.length
      : undefined;
    return {
      fps: meanFrameMs === undefined ? null : 1000 / meanFrameMs,
      frameP95Ms: p95(this.#frames),
      frameMaxMs: this.#frames.length ? Math.max(...this.#frames) : null,
      stallCount: this.#stallCount,
      stallTotalMs: this.#stallTotalMs,
      stallMaxMs: this.#stallMaxMs,
      inputP95Ms: p95(this.#input),
      inputSamples: this.#input.length,
      streamP95Ms: p95(this.#stream),
      streamSamples: this.#stream.length,
    };
  }
}
