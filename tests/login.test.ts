import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startWater } from '../src/web/login-water';

function environment() {
  const dom = new JSDOM('<!doctype html><div id="app"></div><canvas></canvas>', {
    url: 'https://synthetic.invalid',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'FormData',
    'MutationObserver',
    'localStorage',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : (win as any)[name],
    });
  }
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const reduced = Object.assign(new win.EventTarget(), { matches: false });
  const dark = Object.assign(new win.EventTarget(), { matches: false });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    innerWidth: 390,
    innerHeight: 844,
    matchMedia: (query: string) => (query.includes('reduced-motion') ? reduced : dark),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  });
  const advance = (time: number) => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  };
  return {
    dom,
    win,
    frames,
    reduced,
    dark,
    advance,
    canvas: win.document.querySelector('canvas')!,
  };
}

test('water stops for hidden/reduced-motion/paused states, restores after context loss and releases resources', () => {
  const env = environment();
  const calls: string[] = [];
  const gl = new Proxy(
    {},
    {
      get: (_, name: string) => {
        if (name === name.toUpperCase()) return 1;
        return () => {
          calls.push(name);
          if (name.startsWith('create')) return {};
          if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
          if (name === 'getAttribLocation') return 0;
          return null;
        };
      },
    },
  );
  Object.defineProperty(env.canvas, 'getContext', { value: () => gl });
  const water = startWater(env.canvas);
  const draws = () => calls.filter((name) => name === 'drawArrays').length;
  assert.equal(env.frames.size, 1);
  assert.equal(env.canvas.dataset.ready, 'true');
  env.advance(0);
  const initial = draws();
  env.advance(16);
  assert.equal(draws(), initial, 'skip frames above 30 fps');
  env.advance(34);
  assert.equal(draws(), initial + 1);
  water.setPaused(true);
  assert.equal(env.frames.size, 0);
  water.setPaused(false);
  assert.equal(env.frames.size, 1);
  env.reduced.matches = true;
  env.reduced.dispatchEvent(new env.win.Event('change'));
  assert.equal(env.frames.size, 0, 'reduced motion must not schedule animation');
  env.reduced.matches = false;
  env.reduced.dispatchEvent(new env.win.Event('change'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new env.win.Event('visibilitychange'));
  assert.equal(env.frames.size, 0);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new env.win.Event('visibilitychange'));
  assert.equal(env.frames.size, 1);
  env.canvas.dispatchEvent(new env.win.Event('webglcontextlost', { cancelable: true }));
  assert.equal(env.frames.size, 0);
  assert.equal(env.canvas.dataset.ready, undefined, 'expose CSS fallback during context loss');
  env.canvas.dispatchEvent(new env.win.Event('webglcontextrestored'));
  assert.equal(env.frames.size, 1);
  assert.equal(env.canvas.dataset.ready, 'true');
  water.dispose();
  assert.equal(env.frames.size, 0);
  assert.equal(calls.filter((name) => name === 'deleteBuffer').length, 1);
  assert.equal(calls.filter((name) => name === 'deleteProgram').length, 1);
  assert.equal(calls.filter((name) => name === 'deleteShader').length, 2);
  const finalDraws = draws();
  env.win.dispatchEvent(new env.win.Event('resize'));
  env.dark.dispatchEvent(new env.win.Event('change'));
  env.canvas.dispatchEvent(new env.win.Event('webglcontextrestored'));
  assert.equal(draws(), finalDraws, 'unmount removes all rendering listeners');
  env.dom.window.close();
});

test('missing or blocked WebGL leaves the static fallback without scheduling frames', () => {
  for (const blocked of [false, true]) {
    const env = environment();
    Object.defineProperty(env.canvas, 'getContext', {
      value: () => {
        if (blocked) throw new Error('Synthetic blocked context');
        return null;
      },
    });
    const water = startWater(env.canvas);
    assert.equal(env.canvas.dataset.ready, undefined);
    assert.equal(env.frames.size, 0);
    water.dispose();
    env.dom.window.close();
  }
});

test('login preserves form data on failure, prevents duplicate submission and supports setup', async () => {
  const env = environment();
  env.win.HTMLCanvasElement.prototype.getContext = (() => null) as any;
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Login } = await import('../src/web/login');
  const root = createRoot(document.getElementById('app')!);
  const submissions: Record<string, FormDataEntryValue>[] = [];
  let reject!: (error: Error) => void;
  const onSubmit = (data: Record<string, FormDataEntryValue>) => {
    submissions.push(data);
    return new Promise<void>((_, rejectPromise) => {
      reject = rejectPromise;
    });
  };
  const input = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const form = () => document.querySelector<HTMLFormElement>('form')!;
  const submit = () =>
    form().dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(createElement(Login, { setup: false, onSubmit })));
    input('email').value = 'synthetic@example.com';
    input('password').value = 'synthetic-password-only';
    assert.equal(form().checkValidity(), true);
    await act(async () => {
      submit();
      submit();
    });
    assert.equal(submissions.length, 1);
    assert.equal(form().getAttribute('aria-busy'), 'true');
    assert.equal(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      true,
    );
    assert.deepEqual(submissions[0], {
      email: 'synthetic@example.com',
      password: 'synthetic-password-only',
    });
    await act(async () => reject(new Error('合成登录失败')));
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '合成登录失败');
    assert.equal(input('email').value, 'synthetic@example.com');
    assert.equal(input('password').value, 'synthetic-password-only');
    assert.equal(form().getAttribute('aria-busy'), 'false');
    await act(async () => root.render(createElement(Login, { setup: true, onSubmit })));
    assert.equal(input('password').minLength, 12);
    assert.equal(input('password').autocomplete, 'new-password');
    assert.equal(input('setupToken').required, true);
    assert.equal(form().checkValidity(), false);
    input('setupToken').value = 'synthetic-setup-token';
    await act(async () => submit());
    assert.equal(submissions[1].setupToken, 'synthetic-setup-token');
    await act(async () => reject(new Error('合成初始化失败')));
  } finally {
    await act(async () => root.unmount());
    assert.equal(env.frames.size, 0);
    env.dom.window.close();
  }
});
