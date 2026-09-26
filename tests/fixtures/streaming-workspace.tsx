import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../../apps/web/src/app/workspace-app';
import { WorkspaceController } from '../../apps/web/src/features/workspace/workspace-controller';
import { WorkspaceStore } from '../../apps/web/src/features/workspace/workspace-store';

const now = () => performance.timeOrigin + performance.now();
type Sample = { at: number; kind: string; [key: string]: unknown };
const samples: Sample[] = [];
const frames: { at: number; interval: number }[] = [];
const versionSequence = new Map<string, number>();
const cached = new Set<string>();
let measuring = false,
  committedVersion = '',
  latestSequence = 0,
  lastFrame = 0;
const finalWaiters = new Set<() => void>();
const record = (kind: string, values: Record<string, unknown> = {}) => {
  if (measuring) samples.push({ kind, at: now(), ...values });
};
const wake = () => {
  for (const listener of finalWaiters) listener();
};
const transactions = new WeakMap<
  IDBTransaction,
  { at: number; writes: number; deletes: number; checkpoints: number; version?: string }
>();
const track = (transaction: IDBTransaction) => {
  let value = transactions.get(transaction);
  if (value) return value;
  value = { at: now(), writes: 0, deletes: 0, checkpoints: 0 };
  transactions.set(transaction, value);
  const finish = (outcome: string) => {
    record('cache-transaction', { ...value, startedAt: value!.at, at: now(), outcome });
    if (outcome === 'complete' && value!.version) cached.add(value!.version);
    wake();
  };
  transaction.addEventListener('complete', () => finish('complete'), { once: true });
  transaction.addEventListener('abort', () => finish('abort'), { once: true });
  return value;
};
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value, key) {
  const info = track(this.transaction);
  info.writes++;
  if (typeof key === 'string' && key.includes('moor-workspace-session-cache-v2')) {
    if (value?.cacheVersion === 2) info.version = value.version;
    if (key.endsWith(',"checkpoint"]')) info.checkpoints++;
  }
  return originalPut.call(this, value, key);
};
const originalDelete = IDBObjectStore.prototype.delete;
IDBObjectStore.prototype.delete = function (key) {
  track(this.transaction).deletes++;
  return originalDelete.call(this, key);
};
const store = new WorkspaceStore();
const controller = new WorkspaceController({
  store,
  request: async (input) => {
    const startedAt = now();
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const headersAt = now();
    const value = await response.json();
    const version = response.headers.get('x-benchmark-version');
    const sequence = Number(response.headers.get('x-benchmark-sequence'));
    if (version) versionSequence.set(version, sequence);
    record('response', {
      startedAt,
      headersAt,
      sequence,
      version,
      method: input.action === 'execute' ? input.command.method : input.action,
    });
    return value;
  },
});
let publishedVersion = '';
controller.subscribe(() => {
  const version = controller.state.session?.version;
  if (version && version !== publishedVersion) {
    publishedVersion = version;
    record('published', { version, sequence: versionSequence.get(version) });
  }
});
const listeners = new Set<(value: unknown) => void>();
const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events');
socket.onmessage = (event) => {
  const value = JSON.parse(event.data);
  latestSequence = Math.max(latestSequence, value.sequence);
  record('notice', { sequence: value.sequence, hostAt: value.at });
  for (const listener of listeners) listener(value.notice);
};
const subscribe = (listener: (value: unknown) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const root = createRoot(document.getElementById('app')!);
root.render(
  <WorkspaceApp
    controller={controller}
    subscribeSessionChanges={subscribe}
    accountApi={async () => ({
      ok: true,
      value: {
        origin: '',
        owner: null,
        needsSetup: false,
        localOnly: true,
        google: { enabled: false },
      },
    })}
  />,
);
const tick = (time: number) => {
  if (measuring && !document.hidden) {
    if (lastFrame) frames.push({ at: now(), interval: time - lastFrame });
    lastFrame = time;
  } else lastFrame = 0;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
document.addEventListener('visibilitychange', () => {
  record('visibility', { hidden: document.hidden });
  lastFrame = 0;
});
const pendingInput: number[] = [];
const inputFeedback: { startedAt: number; committedAt: number }[] = [];
let inputSequence = 0;
document.addEventListener(
  'input',
  (event) => {
    if (!measuring || !(event.target instanceof HTMLTextAreaElement)) return;
    inputSequence++;
    pendingInput.push(performance.timeOrigin + event.timeStamp);
  },
  true,
);
const text = () =>
  controller.state.session?.history
    .at(-1)
    ?.items?.filter((value: any) => value.type === 'text')
    .map((value: any) => value.text)
    .join('') ?? '';
const geometry = () => {
  const viewport = document.querySelector<HTMLElement>('.workspace-history');
  const code = [
    ...document.querySelectorAll<HTMLElement>('[data-turn-id="benchmark-active"] pre code'),
  ].at(-1);
  const pre = code?.closest('pre');
  if (!viewport || !code || !pre) return null;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let last: Text | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent?.trim()) last = node as Text;
  if (!last) return null;
  const value = last.data;
  const end = value.search(/\s*$/);
  const start = value.lastIndexOf('\n', end - 1) + 1;
  const range = document.createRange();
  range.setStart(last, start);
  range.setEnd(last, end);
  const row = range.getBoundingClientRect(),
    view = viewport.getBoundingClientRect();
  return {
    lastLine: value.slice(start, end),
    row: { top: row.top, bottom: row.bottom, left: row.left, right: row.right },
    viewport: { top: view.top, bottom: view.bottom, left: view.left, right: view.right },
    visible:
      row.bottom > view.top &&
      row.top < view.bottom &&
      row.right > view.left &&
      row.left < view.right,
    preVerticalOverflow: pre.scrollHeight - pre.clientHeight,
    distanceFromBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
  };
};
Object.assign(window, {
  __streamDecoded(version: string) {
    record('decoded', { version, sequence: versionSequence.get(version) });
  },
  __streamCommitted(version: string) {
    if (version) {
      committedVersion = version;
      record('committed', { version, sequence: versionSequence.get(version), latestSequence });
      requestAnimationFrame(() =>
        record('raf-after-commit', { version, sequence: versionSequence.get(version) }),
      );
      wake();
    }
  },
  __streamInputCommitted() {
    for (const startedAt of pendingInput.splice(0))
      inputFeedback.push({ startedAt, committedAt: now() });
  },
  __streamFixture: {
    geometry,
    snapshot: () => ({
      samples,
      frames,
      inputFeedback,
      latestSequence,
      committedVersion,
      inputSequence,
      visibility: document.visibilityState,
      cacheStatus: controller.state.sessionCache,
    }),
    ready: () => socket.readyState === WebSocket.OPEN && !!controller.state.session?.version,
    start() {
      measuring = true;
      lastFrame = 0;
      record('started', {
        hidden: document.hidden,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      });
      document.querySelector<HTMLTextAreaElement>('[aria-label="消息"]')?.focus();
    },
    waitForFinal(version: string) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (committedVersion === version && cached.has(version)) {
            finalWaiters.delete(check);
            resolve();
          }
        };
        finalWaiters.add(check);
        check();
      });
    },
    async finish() {
      await controller.flushDraft();
      const state = controller.state;
      const restored = await store.cachedSession(state.scope!, state.sessionId!, () => {});
      const cachedText = restored?.history
        .at(-1)
        ?.items?.filter((value: any) => value.type === 'text')
        .map((value: any) => value.text)
        .join('');
      const value = {
        samples,
        frames,
        inputFeedback,
        latestSequence,
        committedVersion,
        inputSequence,
        text: text(),
        cachedText,
        cachedVersion: restored?.version,
        finalInput: document.querySelector<HTMLTextAreaElement>('[aria-label="消息"]')?.value,
        visibleCode: [...document.querySelectorAll('[data-turn-id="benchmark-active"] pre code')]
          .map((node) => node.textContent)
          .join('\n'),
        visibility: document.visibilityState,
        offline: state.offline,
        sessionLoad: state.sessionLoad,
        modelError: state.modelError,
        geometry: geometry(),
      };
      measuring = false;
      return value;
    },
  },
});
