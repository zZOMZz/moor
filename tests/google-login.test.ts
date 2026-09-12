import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ReactNode } from 'react';
import type { Identity } from '../src/web/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const flowId = 'f'.repeat(43);
const confirmationCode = 'A123-B456';
const review = {
  flowId,
  mode: 'login' as const,
  desktop: true,
  code: confirmationCode,
  email: 'synthetic@example.test',
};
type Request = { path: string; method: string; body?: unknown };

async function environment() {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://moor.synthetic.invalid/',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  function global(name: string, value: unknown) {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  for (const name of [
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLFormElement',
    'Element',
    'Node',
    'NodeFilter',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'DOMRect',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'navigator',
    'FormData',
    'localStorage',
  ])
    global(name, (win as any)[name]);
  global('window', win);
  global('IS_REACT_ACT_ENVIRONMENT', true);
  global('getComputedStyle', win.getComputedStyle.bind(win));
  global('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  global('cancelAnimationFrame', () => {});
  global(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  global('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  Object.assign(win, {
    matchMedia: globalThis.matchMedia,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  });
  const navigation: { method: 'assign' | 'replace' | 'reload'; target?: string }[] = [];
  global('location', {
    assign: (target: string) => navigation.push({ method: 'assign', target }),
    replace: (target: string) => navigation.push({ method: 'replace', target }),
    reload: () => navigation.push({ method: 'reload' }),
  });
  const requests: Request[] = [];
  let respond: (request: Request) => Response | Promise<Response> = () => {
    throw new Error('Unexpected synthetic request');
  };
  global('fetch', async (path: string, init: RequestInit = {}) => {
    const request: Request = {
      path: String(path),
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    };
    assert.ok(request.path.startsWith('/api/auth/google/'), 'requests stay on the Moor origin');
    requests.push(request);
    return respond(request);
  });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const components = await import('../src/web/google-login');
  const root = createRoot(document.getElementById('app')!);
  let mounted = true;
  async function render(node: ReactNode) {
    await act(async () => root.render(node));
  }
  async function unmount() {
    if (mounted) {
      mounted = false;
      await act(async () => root.unmount());
    }
  }
  function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === label,
    );
    assert.ok(found, `Expected button: ${label}`);
    return found;
  }
  function input(name: string) {
    const found = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    assert.ok(found, `Expected input: ${name}`);
    return found;
  }
  function submit() {
    const form = document.querySelector('form');
    assert.ok(form);
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  }
  function desktop(value: unknown) {
    Object.assign(win, { moorDesktop: { version: 1, googleAuth: value } });
  }
  return {
    ...components,
    act,
    createElement,
    render,
    unmount,
    button,
    input,
    submit,
    desktop,
    requests,
    navigation,
    win,
    respond(fn: typeof respond) {
      respond = fn;
    },
    async close() {
      await unmount();
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('Google setup uses only its initialization token, respects disabled state, and keeps input after failure', async () => {
  const f = await environment();
  try {
    const started = deferred<Response>();
    f.respond(() => started.promise);
    await f.render(f.createElement(f.GoogleStart, { mode: 'setup', disabled: true }));
    assert.equal(f.input('setupToken').required, true);
    assert.equal(f.input('setupToken').type, 'password');
    assert.equal(f.input('setupToken').disabled, true);
    assert.equal(document.querySelector('input[name="password"]'), null);
    assert.equal(document.querySelector('input[name="email"]'), null);
    await f.act(async () => f.button('使用 Google 创建账号').click());
    assert.equal(f.requests.length, 0);
    await f.render(f.createElement(f.GoogleStart, { mode: 'setup' }));
    f.input('setupToken').value = 'synthetic-initialization-proof';
    assert.equal(document.querySelector('form')!.checkValidity(), true);
    await f.act(async () => {
      f.submit();
      f.submit();
    });
    assert.deepEqual(f.requests, [
      {
        path: '/api/auth/google/start',
        method: 'POST',
        body: { mode: 'setup', setupToken: 'synthetic-initialization-proof', desktop: false },
      },
    ]);
    assert.equal(f.input('setupToken').disabled, true);
    assert.equal(f.button('正在打开 Google 登录…').disabled, true);
    await f.act(async () => started.resolve(response({ error: '初始化口令不正确' }, 403)));
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '初始化口令不正确');
    assert.equal(f.input('setupToken').value, 'synthetic-initialization-proof');
    assert.equal(f.button('使用 Google 创建账号').disabled, false);
    assert.deepEqual(f.navigation, []);
  } finally {
    await f.close();
  }
});

test('Google browser start only navigates to the validated Moor handoff path', async () => {
  const f = await environment();
  try {
    f.respond(() => response({ launchPath: 'https://attacker.example/secret' }));
    await f.render(f.createElement(f.GoogleStart, { mode: 'login' }));
    await f.act(async () => f.submit());
    assert.deepEqual(f.navigation, []);
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '登录地址无效，请重新开始');
    f.respond(() => response({ launchPath: '/auth/google/start?flow=' + flowId }));
    await f.act(async () => f.submit());
    assert.deepEqual(f.requests.at(-1)!.body, { mode: 'login', desktop: false });
    assert.deepEqual(f.navigation, [
      { method: 'assign', target: '/auth/google/start?flow=' + flowId },
    ]);
  } finally {
    await f.close();
  }
});

test('Google desktop start uses the private bridge, waits for manual completion and retains pending state', async () => {
  const f = await environment();
  const begins: unknown[] = [];
  let completions = 0,
    cancellations = 0;
  const started = deferred<{ flowId: string; code: string }>();
  let completion = deferred<{ completed: boolean }>();
  f.desktop({
    begin: (input: unknown) => {
      begins.push(input);
      return started.promise;
    },
    complete: () => {
      completions++;
      return completion.promise;
    },
    cancel: async () => {
      cancellations++;
    },
  });
  try {
    await f.render(f.createElement(f.GoogleStart, { mode: 'login' }));
    await f.act(async () => {
      f.submit();
      f.submit();
    });
    assert.deepEqual(begins, [{ mode: 'login' }]);
    await f.act(async () => started.resolve({ flowId, code: confirmationCode }));
    assert.ok(document.body.textContent!.includes(confirmationCode));
    assert.ok(!document.body.textContent!.includes(flowId), 'UI only shows the comparison code');
    assert.equal(completions, 0, 'begin never auto-completes or starts polling');
    assert.deepEqual(f.requests, [], 'renderer never sends desktop handoff secrets');
    await f.act(async () => {
      f.button('完成 Google 登录').click();
      f.button('完成 Google 登录').click();
    });
    assert.equal(completions, 1);
    assert.equal(f.button('取消 Google 登录').disabled, true);
    await f.act(async () => completion.resolve({ completed: false }));
    assert.match(document.querySelector('[role="alert"]')!.textContent ?? '', /系统浏览器/);
    assert.ok(document.body.textContent!.includes(confirmationCode));
    assert.deepEqual(f.navigation, []);
    completion = deferred();
    await f.act(async () => f.button('完成 Google 登录').click());
    await f.act(async () => completion.resolve({ completed: true }));
    assert.equal(completions, 2);
    assert.deepEqual(f.navigation, [{ method: 'reload' }]);
    await f.unmount();
    assert.equal(cancellations, 0, 'success clears the pending cancellation lease');
  } finally {
    await f.close();
  }
});

test('Google desktop cancel and pending unmount cancel the private attempt without completing it', async () => {
  const f = await environment();
  let cancellations = 0,
    completions = 0;
  const cancelled = deferred<void>();
  f.desktop({
    begin: async () => ({ flowId, code: confirmationCode }),
    complete: async () => {
      completions++;
      return { completed: false };
    },
    cancel: () => {
      cancellations++;
      return cancelled.promise;
    },
  });
  try {
    await f.render(f.createElement(f.GoogleStart, { mode: 'login' }));
    await f.act(async () => f.submit());
    await f.act(async () => {
      f.button('取消 Google 登录').click();
      f.button('取消 Google 登录').click();
    });
    assert.equal(cancellations, 1);
    await f.act(async () => cancelled.resolve());
    assert.equal(document.querySelector('.google-confirm-code'), null);
    assert.ok(f.button('使用 Google 登录'));
    await f.act(async () => f.submit());
    await f.unmount();
    assert.equal(cancellations, 2, 'unmount explicitly releases a still-pending desktop attempt');
    assert.equal(completions, 0);
    assert.deepEqual(f.navigation, []);
  } finally {
    await f.close();
  }
});

test('Google desktop begin or complete failures remain visible and do not trigger a navigation', async () => {
  const f = await environment();
  let begins = 0,
    cancellations = 0;
  f.desktop({
    begin: async () => {
      if (++begins === 1) throw new Error('Google 登录请求已失效，请重新开始');
      return { flowId, code: confirmationCode };
    },
    complete: async () => {
      throw new Error('Google 登录请求已失效，请重新开始');
    },
    cancel: async () => {
      cancellations++;
    },
  });
  try {
    await f.render(f.createElement(f.GoogleStart, { mode: 'link' }));
    f.input('password').value = 'synthetic-password';
    await f.act(async () => f.submit());
    assert.equal(
      document.querySelector('[role="alert"]')!.textContent,
      'Google 登录请求已失效，请重新开始',
    );
    assert.equal(f.input('password').value, 'synthetic-password');
    await f.act(async () => f.submit());
    await f.act(async () => f.button('完成 Google 登录').click());
    assert.equal(
      document.querySelector('[role="alert"]')!.textContent,
      'Google 登录请求已失效，请重新开始',
    );
    assert.ok(document.querySelector('.google-confirm-code'));
    assert.deepEqual(f.navigation, []);
    await f.unmount();
    assert.equal(cancellations, 1);
  } finally {
    await f.close();
  }
});

test('Google desktop begin settling after unmount cannot complete or navigate', async () => {
  const f = await environment();
  const started = deferred<{ flowId: string; code: string }>();
  let cancellations = 0,
    completions = 0;
  f.desktop({
    begin: () => started.promise,
    complete: async () => {
      completions++;
      return { completed: true };
    },
    cancel: async () => {
      cancellations++;
    },
  });
  try {
    await f.render(f.createElement(f.GoogleStart, { mode: 'login' }));
    await f.act(async () => f.submit());
    await f.unmount();
    assert.equal(cancellations, 1);
    await f.act(async () => started.resolve({ flowId, code: confirmationCode }));
    assert.ok(cancellations >= 1);
    assert.equal(completions, 0);
    assert.deepEqual(f.navigation, []);
  } finally {
    await f.close();
  }
});

test('Google callback page only reviews until the desktop code is explicitly matched and confirmed once', async () => {
  const f = await environment();
  const approved = deferred<Response>();
  f.respond((request) => (request.path.endsWith('/review') ? response(review) : approved.promise));
  try {
    await f.render(f.createElement(f.GoogleComplete));
    assert.deepEqual(f.requests, [{ path: '/api/auth/google/review', method: 'GET' }]);
    assert.ok(document.body.textContent!.includes(review.email));
    assert.ok(document.body.textContent!.includes(confirmationCode));
    assert.equal(f.button('允许这次桌面登录').disabled, true);
    await f.act(async () => f.button('允许这次桌面登录').click());
    assert.equal(f.requests.length, 1, 'unchecked review never authorizes');
    await f.act(async () =>
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await f.act(async () => {
      f.button('允许这次桌面登录').click();
      f.button('允许这次桌面登录').click();
    });
    assert.deepEqual(f.requests[1], {
      path: '/api/auth/google/confirm',
      method: 'POST',
      body: { flowId },
    });
    assert.equal(f.requests.length, 2);
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
      true,
    );
    await f.act(async () => approved.resolve(response({ ok: true })));
    assert.equal(document.querySelector('h1')!.textContent, '浏览器确认已完成');
    assert.equal(document.querySelector('button'), null);
    assert.deepEqual(f.navigation, [], 'browser confirmation never claims the desktop login');
  } finally {
    await f.close();
  }
});

test('Google browser confirmation stays manual and navigates only after a successful response', async () => {
  const f = await environment();
  const confirmed = deferred<Response>();
  f.respond((request) =>
    request.path.endsWith('/review')
      ? response({ ...review, desktop: false, mode: 'link' })
      : confirmed.promise,
  );
  try {
    await f.render(f.createElement(f.GoogleComplete));
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
    assert.deepEqual(f.navigation, []);
    assert.equal(f.requests.length, 1);
    await f.act(async () => f.button('确认绑定 Google 账号').click());
    assert.deepEqual(f.navigation, []);
    await f.act(async () => confirmed.resolve(response({ ok: true })));
    assert.deepEqual(f.navigation, [{ method: 'replace', target: '/' }]);
  } finally {
    await f.close();
  }
});

test('Google expired review and confirm errors render as text and never authorize or navigate', async () => {
  const f = await environment();
  const error = '请求已失效 <img src=x onerror=synthetic()> <script>synthetic()</script>';
  f.respond(() => response({ error }, 401));
  try {
    await f.render(f.createElement(f.GoogleComplete));
    assert.equal(document.querySelector('[role="alert"]')!.textContent, error);
    assert.equal(document.querySelector('img,script'), null);
    assert.equal(document.querySelector('button'), null);
    assert.deepEqual(f.requests, [{ path: '/api/auth/google/review', method: 'GET' }]);
    await f.render(null);
    f.respond((request) =>
      request.path.endsWith('/review') ? response(review) : response({ error }, 401),
    );
    await f.render(f.createElement(f.GoogleComplete));
    await f.act(async () =>
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await f.act(async () => f.button('允许这次桌面登录').click());
    assert.equal(document.querySelector('[role="alert"]')!.textContent, error);
    assert.equal(document.querySelector('img,script'), null);
    assert.equal(document.querySelector('h1')!.textContent, '确认 Google 账号');
    assert.equal(f.button('允许这次桌面登录').disabled, false);
    assert.deepEqual(f.navigation, []);
  } finally {
    await f.close();
  }
});

const identity: Identity = {
  owner: 'synthetic-owner',
  needsSetup: false,
  localOnly: false,
  google: { enabled: true, linked: null, hasPassword: true },
};

test('Google account linking requests the current password and retains it after an expired attempt', async () => {
  const f = await environment();
  let refreshes = 0,
    closes = 0;
  f.respond(() => response({ error: '原登录已失效，请重新登录后绑定' }, 401));
  try {
    await f.render(
      f.createElement(f.GoogleAccount, {
        identity,
        onRefresh: async () => {
          refreshes++;
        },
        onClose: () => {
          closes++;
        },
      }),
    );
    assert.equal(f.input('password').required, true);
    assert.equal(f.input('password').autocomplete, 'current-password');
    f.input('password').value = 'synthetic-current-password';
    await f.act(async () => f.submit());
    assert.deepEqual(f.requests, [
      {
        path: '/api/auth/google/start',
        method: 'POST',
        body: {
          mode: 'link',
          password: 'synthetic-current-password',
          desktop: false,
        },
      },
    ]);
    assert.equal(f.input('password').value, 'synthetic-current-password');
    assert.equal(
      document.querySelector('[role="alert"]')!.textContent,
      '原登录已失效，请重新登录后绑定',
    );
    assert.equal(refreshes, 0);
    await f.act(async () => f.button('关闭 Google 登录设置').click());
    assert.equal(closes, 1);
  } finally {
    await f.close();
  }
});

test('Google account unlink is single-flight, keeps password on failure, and refreshes only on success', async () => {
  const f = await environment();
  let refreshes = 0,
    closes = 0;
  const unlinked = deferred<Response>();
  f.respond(() => unlinked.promise);
  try {
    await f.render(
      f.createElement(f.GoogleAccount, {
        identity: {
          ...identity,
          google: { enabled: true, linked: { email: review.email }, hasPassword: true },
        },
        onRefresh: async () => {
          refreshes++;
        },
        onClose: () => {
          closes++;
        },
      }),
    );
    assert.ok(document.body.textContent!.includes(review.email));
    f.input('password').value = 'synthetic-current-password';
    await f.act(async () => {
      f.submit();
      f.submit();
    });
    assert.deepEqual(f.requests, [
      {
        path: '/api/auth/google/unlink',
        method: 'POST',
        body: { password: 'synthetic-current-password' },
      },
    ]);
    assert.equal(f.input('password').disabled, true);
    assert.equal(f.button('关闭 Google 登录设置').disabled, true);
    await f.act(async () => unlinked.resolve(response({ error: '原登录已失效，请重新登录' }, 401)));
    assert.equal(refreshes, 0);
    assert.equal(closes, 0);
    assert.equal(f.input('password').value, 'synthetic-current-password');
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '原登录已失效，请重新登录');
    f.respond(() => response({ ok: true }));
    await f.act(async () => f.submit());
    assert.equal(refreshes, 1);
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});

test('Google-only accounts cannot unlink their last credential and unconfigured relays expose no Google action', async () => {
  const f = await environment();
  try {
    const props = { onRefresh: async () => {}, onClose: () => {} };
    await f.render(
      f.createElement(f.GoogleAccount, {
        ...props,
        identity: {
          ...identity,
          google: { enabled: true, linked: { email: review.email }, hasPassword: false },
        },
      }),
    );
    assert.equal(document.querySelector('input[name="password"]'), null);
    assert.equal(document.querySelector('form'), null);
    assert.ok(document.body.textContent!.includes('中转服务器本机设置恢复密码'));
    await f.render(
      f.createElement(f.GoogleAccount, {
        ...props,
        identity: { ...identity, google: { enabled: false } },
      }),
    );
    assert.ok(document.body.textContent!.includes('此中转尚未配置 Google 登录'));
    assert.equal(document.querySelector('form'), null);
    assert.deepEqual(f.requests, []);
  } finally {
    await f.close();
  }
});
