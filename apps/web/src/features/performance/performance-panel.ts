import { PerformanceMetrics } from './performance-metrics';
import { observePerformanceSignals } from './performance-signals';
import './performance-panel.css';

type CpuSample = { rendererCpuPercent: number | null };
type SessionUpdate = { sessionId: string; version: string; started: number };

/** A separate, opt-in DOM subtree: sampling never updates the application's React state. */
export function installPerformancePanel(options: { sampleCpu?: () => Promise<CpuSample> } = {}) {
  if (document.getElementById('moor-performance')) return () => {};
  const host = document.createElement('div');
  host.id = 'moor-performance';
  host.className = 'dev-performance';
  host.innerHTML = `
    <button type="button" class="dev-performance-launcher" aria-label="打开性能面板"
      aria-keyshortcuts="Meta+Alt+P Control+Alt+P" title="开发性能（⌘ / Ctrl Alt P）">性能 <span>DEV</span></button>
    <aside hidden aria-label="开发性能面板" class="dev-performance-panel" data-state="hidden">
      <header><div><strong>开发性能</strong><span class="dev-performance-state">采样中</span></div>
        <button type="button" aria-label="关闭性能面板" title="关闭并停止采样">×</button></header>
      <p class="dev-performance-caption">当前开发构建 · 前台采样 · 500ms 刷新</p>
      <dl>
        <div><dt>FPS 估计</dt><dd data-perf-metric="fps">—</dd></div>
        <div><dt>帧间隔 p95</dt><dd data-perf-metric="frameP95Ms">—</dd></div>
        <div><dt>停顿次数 <small>＞100ms</small></dt><dd data-perf-metric="stallCount">0</dd></div>
        <div><dt>最长停顿</dt><dd data-perf-metric="stallMaxMs">—</dd></div>
        <div><dt>累计停顿</dt><dd data-perf-metric="stallTotalMs">0 ms</dd></div>
        <div><dt>Renderer CPU</dt><dd data-perf-metric="cpu">—</dd></div>
        <div><dt>输入提交 p95 <small><span data-perf-metric="inputSamples">0</span> 次</small></dt><dd data-perf-metric="inputP95Ms">—</dd></div>
        <div><dt>回复提交 p95 <small><span data-perf-metric="streamSamples">0</span> 次</small></dt><dd data-perf-metric="streamP95Ms">—</dd></div>
      </dl>
      <details><summary>指标口径</summary><div class="dev-performance-notes">
        <p>FPS 是最近 120 个前台 rAF 间隔的估计，并非屏幕实际呈现帧率。帧间隔 p95 使用同一窗口。</p>
        <p>停顿指单次前台帧间隔超过 100ms。累计值相加这些间隔的完整时长；次数、最长与累计从本次开启或重置起计算。切到后台时暂停。</p>
        <p>输入提交：编辑框输入事件到 React 提交。回复提交：客户端完成响应校验后，经过会话解码、缓存到对应版本 DOM 提交；不含传输、响应校验与通知合并，也不代表像素已呈现。只统计已有会话的版本变化。p95 各保留最近 200 次。</p>
        <p>CPU 仅为当前 Renderer 的区间采样；首次、恢复前台或不可用时显示 —。本面板只在内存中保留有界样本，关闭即停止采样。</p>
      </div></details>
      <footer><span>开发诊断，非生产基准</span><button type="button" aria-label="重置性能统计">重置</button></footer>
    </aside>`;
  document.body.append(host);
  const launcher = host.querySelector<HTMLButtonElement>('.dev-performance-launcher')!;
  const panel = host.querySelector<HTMLElement>('aside')!;
  const stateLabel = host.querySelector<HTMLElement>('.dev-performance-state')!;
  const metric = (key: string, value: string) => {
    const node = host.querySelector<HTMLElement>(`[data-perf-metric="${key}"]`)!;
    if (node.textContent !== value) node.textContent = value;
  };
  const milliseconds = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)} ms`);
  const metrics = new PerformanceMetrics();
  let opened = false;
  let collecting = false;
  let disposed = false;
  let epoch = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unobserve: (() => void) | undefined;
  let input = new WeakMap<HTMLTextAreaElement, number[]>();
  let sessions = new WeakMap<object, SessionUpdate>();
  let cpu: number | null = null;
  let cpuPending = false;
  let cpuWarm = false;
  const clearPending = () => {
    epoch++;
    input = new WeakMap();
    sessions = new WeakMap();
  };
  const paint = () => {
    const value = metrics.snapshot();
    metric('fps', value.fps === null ? '—' : value.fps.toFixed(0));
    for (const key of [
      'frameP95Ms',
      'stallMaxMs',
      'stallTotalMs',
      'inputP95Ms',
      'streamP95Ms',
    ] as const)
      metric(key, milliseconds(value[key]));
    for (const key of ['stallCount', 'inputSamples', 'streamSamples'] as const)
      metric(key, String(value[key]));
    metric('cpu', cpu === null ? '—' : `${cpu.toFixed(1)}%`);
  };
  const sampleCpu = () => {
    if (!collecting || cpuPending || !options.sampleCpu) return;
    cpuPending = true;
    const current = epoch;
    const read = options.sampleCpu;
    void Promise.resolve()
      .then(read)
      .then(
        (sample) => {
          if (!collecting || current !== epoch) return;
          const value = sample.rendererCpuPercent;
          cpu =
            cpuWarm && typeof value === 'number' && Number.isFinite(value) && value >= 0
              ? value
              : null;
          cpuWarm = true;
          metric('cpu', cpu === null ? '—' : `${cpu.toFixed(1)}%`);
        },
        () => {
          if (collecting && current === epoch) {
            cpu = null;
            metric('cpu', '—');
          }
        },
      )
      .finally(() => {
        cpuPending = false;
      });
  };
  const stop = () => {
    collecting = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearInterval(timer);
    frame = undefined;
    timer = undefined;
    unobserve?.();
    unobserve = undefined;
    clearPending();
    metrics.suspend();
    cpu = null;
    cpuWarm = false;
  };
  const start = () => {
    if (!opened || disposed || document.visibilityState === 'hidden' || collecting) return;
    collecting = true;
    const now = () => performance.now();
    unobserve = observePerformanceSignals({
      inputChanged(target, timestamp) {
        const time = now();
        const pending = input.get(target) ?? [];
        if (pending.length === 200) pending.shift();
        pending.push(
          Number.isFinite(timestamp) && timestamp > 0 && timestamp <= time ? timestamp : time,
        );
        input.set(target, pending);
      },
      inputCommitted(target) {
        const pending = input.get(target);
        if (!pending) return;
        input.delete(target);
        const time = now();
        for (const started of pending) metrics.latency('input', time - started);
      },
      sessionReceived() {
        const started = now(),
          current = epoch;
        return (owner, sessionId, version) => {
          if (collecting && epoch === current) sessions.set(owner, { sessionId, version, started });
        };
      },
      sessionCommitted(owner, sessionId, version, visible) {
        const pending = sessions.get(owner);
        sessions.delete(owner);
        if (!visible || !pending || pending.sessionId !== sessionId || pending.version !== version)
          return;
        metrics.latency('stream', now() - pending.started);
      },
    });
    const tick = (timestamp: number) => {
      if (!collecting) return;
      metrics.frame(timestamp);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    timer = setInterval(() => {
      paint();
      sampleCpu();
    }, 500);
    sampleCpu();
  };
  const visibility = () => {
    if (!opened) return;
    if (document.visibilityState === 'hidden') stop();
    else start();
    panel.dataset.state = collecting ? 'sampling' : 'hidden';
    stateLabel.textContent = collecting ? '采样中' : '后台已暂停';
    paint();
  };
  const close = () => {
    opened = false;
    stop();
    document.removeEventListener('visibilitychange', visibility);
    panel.hidden = true;
    panel.dataset.state = 'hidden';
    launcher.hidden = false;
  };
  const open = () => {
    opened = true;
    metrics.reset();
    launcher.hidden = true;
    panel.hidden = false;
    document.addEventListener('visibilitychange', visibility);
    visibility();
  };
  launcher.addEventListener('click', open);
  host.querySelector('[aria-label="关闭性能面板"]')!.addEventListener('click', () => {
    close();
    launcher.focus();
  });
  host.querySelector('[aria-label="重置性能统计"]')!.addEventListener('click', () => {
    clearPending();
    metrics.reset();
    cpu = null;
    cpuWarm = false;
    paint();
  });
  const shortcut = (event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      event.code === 'KeyP' &&
      !event.repeat
    ) {
      event.preventDefault();
      if (opened) close();
      else open();
    }
  };
  document.addEventListener('keydown', shortcut);
  return () => {
    disposed = true;
    close();
    document.removeEventListener('keydown', shortcut);
    host.remove();
  };
}
