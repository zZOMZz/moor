import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { SecureAccountApi, SecureUiController } from '../src/web/secure-app';
import type { SecureWorkspaceState } from '../src/web/secure-controller';

const pin = {
  serverOrigin: 'https://relay.synthetic.invalid',
  accountId: 'synthetic-owner',
  rootKeyId: 'a'.repeat(43),
};
const account = {
  origin: pin.serverOrigin,
  owner: pin.accountId,
  needsSetup: false,
  google: { enabled: false },
};
function seed(): SecureWorkspaceState {
  return {
    status: { device: { phase: 'empty', revision: null }, connecting: false, connection: null },
    hostId: null,
    catalog: null,
    replicaId: null,
    sessions: [],
    session: null,
    operations: [],
    draft: '',
    notice: null,
    busy: false,
  };
}
function connected(): SecureWorkspaceState {
  const state = seed();
  state.status = {
    device: {
      phase: 'active',
      revision: 2,
      pin,
      deviceId: 'client',
      roles: ['client'],
      trustEpoch: 1,
      pending: null,
      trust: null,
      devices: [],
    },
    connecting: false,
    connection: {
      connectionId: 'b819e99c-be2c-4a9c-81dd-b9f465cbcf69',
      phase: 'connected',
      verified: false,
      hosts: [
        {
          deviceId: 'host',
          keyId: 'b'.repeat(43),
          rootKeyId: pin.rootKeyId,
          trustEpoch: 1,
          trustDigest: 'c'.repeat(43),
          hostChallenge: 'd'.repeat(43),
        },
      ],
    },
  };
  state.hostId = 'host';
  state.replicaId = 'replica';
  state.catalog = {
    catalogVersion: 2,
    machineId: 'machine',
    workspaces: [
      {
        id: 'runtime',
        name: '合成运行目录',
        userId: 'user',
        machineId: 'machine',
        projects: [{ id: 'local', name: '合成项目', rootPath: '/synthetic/project' }],
        agents: [{ id: 'agent', name: '合成 Agent', cliType: 'synthetic', agentType: 'synthetic' }],
      },
    ],
    products: {
      version: 1,
      authority: { ...pin, hostDeviceId: 'host' },
      revision: 3,
      workspaces: [{ id: 'workspace', name: '工作区' }],
      projects: [
        { id: 'project', workspaceId: 'workspace', name: '合成项目', source: { kind: 'local' } },
      ],
      replicas: [
        {
          id: 'replica',
          catalogWorkspaceId: 'workspace',
          projectId: 'project',
          revision: 3,
          runtimeWorkspaceId: 'runtime',
          localProjectId: 'local',
          machineId: 'machine',
          userId: 'user',
          available: true,
        },
      ],
    },
  } as SecureWorkspaceState['catalog'];
  state.session = {
    meta: {
      id: 'session',
      userId: 'user',
      machineId: 'machine',
      project: { kind: 'local', localProjectId: 'local' },
      agentConfigId: 'agent',
      cliType: 'synthetic',
      agentType: 'synthetic',
      title: '合成会话',
      metadataRevision: 0,
    },
    metaBundle: { version: 1, entries: {} },
    update: '',
    synced: true,
    online: true,
    persisted: true,
    history: [],
  };
  state.sessions = [state.session.meta];
  return state;
}
function fake(initial = seed()) {
  let state = initial;
  const calls: { name: string; args: unknown[] }[] = [];
  const listeners = new Set<(state: SecureWorkspaceState) => void>();
  const emit = () => listeners.forEach((listener) => listener(structuredClone(state)));
  const controller = {
    get state() {
      return structuredClone(state);
    },
    subscribe(listener: (state: SecureWorkspaceState) => void) {
      listeners.add(listener);
      listener(structuredClone(state));
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate() {
      state = seed();
      emit();
    },
    close() {
      calls.push({ name: 'close', args: [] });
      state = seed();
      emit();
    },
  } as unknown as SecureUiController;
  for (const name of [
    'refreshStatus',
    'device',
    'connect',
    'disconnect',
    'selectHost',
    'selectReplica',
    'refreshSessions',
    'openSession',
    'refreshSession',
    'createSession',
    'send',
    'stop',
    'metadata',
    'recover',
    'refreshOperations',
    'saveDraft',
  ] as const) {
    (controller as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      calls.push({ name, args });
      if (name === 'saveDraft') {
        state.draft = String(args[0]);
        emit();
      }
      if (name === 'send') {
        state.draft = '';
        emit();
      }
    };
  }
  return {
    controller,
    calls,
    update(value: SecureWorkspaceState) {
      state = value;
      emit();
    },
  };
}
async function mount(
  state = seed(),
  identity = account,
  logout?: () => ReturnType<SecureAccountApi>,
) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'moor-client://app/remote/',
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of [
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLFormElement',
    'Element',
    'Node',
    'MutationObserver',
    'Event',
    'MouseEvent',
    'navigator',
    'FormData',
  ])
    setGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
  setGlobal('window', dom.window);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SecureApp } = await import('../src/web/secure-app');
  const fixture = fake(state);
  const accountCalls: unknown[] = [];
  const accountApi: SecureAccountApi = async (request) => {
    accountCalls.push(request);
    if (request.action === 'logout' && logout) return logout();
    return { ok: true, value: identity };
  };
  const root = createRoot(dom.window.document.getElementById('app')!);
  await act(async () => {
    root.render(createElement(SecureApp, { controller: fixture.controller, accountApi }));
  });
  const button = (text: string) => {
    const element = [...dom.window.document.querySelectorAll('button')].find(
      (entry) => entry.textContent === text,
    );
    assert.ok(element, `Missing button: ${text}`);
    return element;
  };
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype =
      element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  async function submit(form: HTMLFormElement) {
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
  }
  return {
    ...fixture,
    document: dom.window.document,
    act,
    button,
    click,
    input,
    submit,
    accountCalls,
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('trusted desktop reads status without connecting or replaying; unavailable Google login is honest', async () => {
  const view = await mount(seed(), { ...account, owner: null } as unknown as typeof account);
  try {
    assert.match(view.document.body.textContent!, /尚未配置 Google 登录/);
    assert.equal(view.document.querySelector('input[type=password]'), null);
    assert.deepEqual(view.accountCalls, [{ action: 'status' }]);
    assert.deepEqual(view.calls, []);
  } finally {
    await view.cleanup();
  }
});

test('pairing takes account and origin from account identity, only root fingerprint from input', async () => {
  const view = await mount();
  try {
    const field = view.document.querySelector('input')!;
    const pattern = new RegExp('^(?:' + field.pattern + ')$', 'v');
    assert.equal(pattern.test('-_Z'.repeat(14) + 'a'), true);
    assert.equal(pattern.test('!'.repeat(43)), false);
    await view.input(field, 'z'.repeat(43));
    await view.submit(field.form!);
    assert.deepEqual(view.calls, [
      { name: 'refreshStatus', args: [] },
      {
        name: 'device',
        args: [
          {
            action: 'device-pair',
            expectedRevision: null,
            pin: { ...pin, rootKeyId: 'z'.repeat(43) },
          },
        ],
      },
    ]);
    assert.equal(view.button('连接').disabled, true);
  } finally {
    await view.cleanup();
  }
});

test('expired pending request displays only public pairing data and requires renewal before acceptance', async () => {
  const state = seed();
  state.status!.device = {
    phase: 'pending',
    revision: 1,
    pin,
    deviceId: 'client',
    roles: ['client'],
    trustEpoch: null,
    trust: null,
    devices: [],
    pending: {
      request: {
        version: 1,
        pairingId: 'b'.repeat(43),
        accountId: pin.accountId,
        serverOrigin: pin.serverOrigin,
        rootKeyId: pin.rootKeyId,
        device: {
          deviceId: 'client',
          keyId: 'c'.repeat(43),
          publicKey: 'B' + 'x'.repeat(86),
          roles: ['client'],
        },
        expiresAt: 100,
      },
      fingerprint: 'd'.repeat(43),
      expired: true,
    },
  };
  const view = await mount(state);
  try {
    assert.match(view.document.body.textContent!, /配对请求已过期/);
    assert.equal(view.document.querySelector('output')!.textContent, 'd'.repeat(43));
    assert.equal(view.button('核对并接受配对').disabled, true);
    await view.click('续期请求');
    await view.click('取消配对');
    assert.deepEqual(view.calls.slice(1), [
      { name: 'device', args: [{ action: 'device-renew', expectedRevision: 1 }] },
      { name: 'device', args: [{ action: 'device-cancel', expectedRevision: 1 }] },
    ]);
    assert.doesNotMatch(
      view.document.querySelector('textarea')!.value,
      /privateKey|recovery|capsule/,
    );
  } finally {
    await view.cleanup();
  }
});

test('session controls are explicit and pass selected Agent and metadata action', async () => {
  const view = await mount(connected());
  try {
    assert.match(view.document.body.textContent!, /已核对执行主机目录/);
    await view.click('新建会话');
    await view.click('置顶会话');
    await view.click('归档会话');
    await view.click('刷新会话');
    assert.deepEqual(view.calls.slice(1), [
      { name: 'createSession', args: ['agent'] },
      { name: 'metadata', args: ['pin'] },
      { name: 'metadata', args: ['archive'] },
      { name: 'refreshSession', args: [] },
    ]);
    assert.equal(view.button('停止回合').disabled, true);
  } finally {
    await view.cleanup();
  }
});

test('draft is saved before explicit send and unsaved edits prevent switching scope', async () => {
  const view = await mount(connected());
  try {
    const field = view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!;
    await view.input(field, '只使用合成数据');
    assert.equal(view.button('新建会话').disabled, true);
    assert.equal(view.button('断开连接').disabled, true);
    assert.match(view.document.body.textContent!, /草稿尚未保存/);
    await view.submit(field.form!);
    assert.deepEqual(view.calls.slice(1), [
      { name: 'saveDraft', args: ['只使用合成数据'] },
      { name: 'send', args: ['只使用合成数据'] },
    ]);
    assert.equal(field.value, '');
  } finally {
    await view.cleanup();
  }
});

test('offline session can save drafts but cannot send or recover until explicit connection', async () => {
  const state = connected();
  state.status!.connection = null;
  const view = await mount(state);
  try {
    await view.input(
      view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!,
      '离线草稿',
    );
    assert.equal(view.button('发送').disabled, true);
    await view.click('保存草稿');
    assert.deepEqual(view.calls.slice(1), [{ name: 'saveDraft', args: ['离线草稿'] }]);
    assert.equal(
      view.calls.some((call) => call.name === 'connect' || call.name === 'send'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('unconfirmed operations expose exact scope and only manually recover the original id', async () => {
  const state = connected();
  state.operations = [
    {
      operationId: 'original-id',
      kind: 'turn',
      target: {
        origin: pin.serverOrigin,
        owner: pin.accountId,
        rootKeyId: pin.rootKeyId,
        clientDeviceId: 'client',
        hostDeviceId: 'host',
        workspaceId: 'runtime',
        localProjectId: 'local',
        machineId: 'machine',
        userId: 'user',
        sessionId: 'session',
        product: {
          catalogWorkspaceId: 'workspace',
          projectId: 'project',
          replicaId: 'original-replica',
          revision: 2,
        },
      },
      body: 'private original body should not be rendered',
      requestVersion: 'sha256:' + 'a'.repeat(64),
      state: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const view = await mount(state);
  try {
    assert.match(view.document.body.textContent!, /host/);
    assert.match(view.document.body.textContent!, /original-replica · 版本 2/);
    assert.doesNotMatch(view.document.body.textContent!, /private original body/);
    assert.equal(view.button('发送').disabled, true);
    assert.equal(view.document.querySelector('.secure-operations')!.hasAttribute('open'), true);
    await view.click('核查原操作');
    await view.click('重试原操作');
    await view.click('放弃原操作');
    assert.deepEqual(
      view.calls.slice(1),
      ['inspect', 'retry', 'abandon'].map((mode) => ({
        name: 'recover',
        args: ['original-id', mode],
      })),
    );
    await view.act(async () =>
      view.update({
        ...state,
        operations: state.operations.map((operation) => ({
          ...operation,
          target: { ...operation.target, hostDeviceId: 'another-host' },
        })),
      }),
    );
    await view.input(
      view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!,
      '当前主机的新草稿',
    );
    assert.equal(view.button('发送').disabled, false, '另一个主机的原操作不能阻塞当前执行范围');
  } finally {
    await view.cleanup();
  }
});

test('conversation text stays text and pending approval never creates an unbound approval button', async () => {
  const state = connected();
  state.session!.history = [
    {
      id: 'turn',
      $cid: 'synthetic-turn-cid',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      finished: false,
      userId: undefined,
      userTurnId: undefined,
      status: undefined,
      read: undefined,
      inputConfig: undefined,
      fileDiff: undefined,
      items: [
        { type: 'text', text: '<img src=x onerror="steal()">' },
        {
          type: 'tool_call',
          title: '合成工具',
          status: 'pending',
          permissionRequest: {
            requestId: 'request',
            options: [{ optionId: 'allow', name: '允许一次' }],
          },
        },
      ],
    },
  ];
  const view = await mount(state);
  try {
    assert.equal(view.document.querySelector('.secure-history img'), null);
    assert.match(view.document.querySelector('.secure-history')!.textContent!, /<img src=x/);
    assert.match(view.document.body.textContent!, /请在执行电脑处理这次请求/);
    assert.equal(
      [...view.document.querySelectorAll('button')].some(
        (element) => element.textContent === '允许一次',
      ),
      false,
    );
    assert.equal(view.button('发送').disabled, true);
    assert.equal(view.button('停止回合').disabled, false);
    await view.click('停止回合');
    assert.deepEqual(view.calls.at(-1), { name: 'stop', args: [] });
  } finally {
    await view.cleanup();
  }
});

test('mismatched logged-in account hides prior device conversation and operation controls', async () => {
  const state = connected();
  const view = await mount(state, { ...account, owner: 'other-account' });
  try {
    assert.match(view.document.body.textContent!, /设备与当前账号不匹配/);
    assert.equal(view.document.querySelector('.secure-history'), null);
    assert.equal(view.document.querySelector('#secure-prompt'), null);
    assert.equal(view.document.querySelector('.secure-operations'), null);
    assert.equal(
      view.calls.some((call) => call.name === 'connect'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('pairing acceptance submits the displayed revision and public approval material only', async () => {
  const state = seed();
  state.status!.device = {
    phase: 'pending',
    revision: 4,
    pin,
    deviceId: 'client',
    roles: ['client'],
    trustEpoch: null,
    trust: null,
    devices: [],
    pending: {
      request: {
        version: 1,
        pairingId: 'b'.repeat(43),
        accountId: pin.accountId,
        serverOrigin: pin.serverOrigin,
        rootKeyId: pin.rootKeyId,
        device: {
          deviceId: 'client',
          keyId: 'c'.repeat(43),
          publicKey: 'B' + 'x'.repeat(86),
          roles: ['client'],
        },
        expiresAt: 100,
      },
      fingerprint: 'd'.repeat(43),
      expired: false,
    },
  };
  const view = await mount(state);
  try {
    const rootPublicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) };
    const publicKeyField =
      view.document.querySelector<HTMLTextAreaElement>('[name=rootPublicKey]')!;
    await view.input(publicKeyField, '{invalid');
    await view.submit(publicKeyField.form!);
    assert.match(view.document.body.textContent!, /根公钥需要是有效的 JSON/);
    assert.deepEqual(view.calls, [{ name: 'refreshStatus', args: [] }]);
    await view.input(publicKeyField, JSON.stringify(rootPublicKey));
    await view.input(
      view.document.querySelector<HTMLTextAreaElement>('[name=approval]')!,
      ' synthetic.approval.jws ',
    );
    await view.input(
      view.document.querySelector<HTMLTextAreaElement>('[name=signedManifest]')!,
      ' synthetic.manifest.jws ',
    );
    await view.submit(publicKeyField.form!);
    assert.deepEqual(view.calls.at(-1), {
      name: 'device',
      args: [
        {
          action: 'device-accept',
          expectedRevision: 4,
          rootPublicKey,
          approval: 'synthetic.approval.jws',
          signedManifest: 'synthetic.manifest.jws',
        },
      ],
    });
  } finally {
    await view.cleanup();
  }
});

test('a failed or unconfirmed send preserves the persisted draft and shows a recoverable error', async () => {
  const view = await mount(connected());
  try {
    view.controller.send = async () => {
      throw new Error('原操作结果待确认，请手动核查');
    };
    const field = view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!;
    await view.input(field, '保留此合成草稿');
    await view.submit(field.form!);
    assert.equal(field.value, '保留此合成草稿');
    assert.equal(view.controller.state.draft, '保留此合成草稿');
    assert.match(view.document.querySelector('[role=alert]')!.textContent!, /原操作结果待确认/);
    assert.equal(
      view.calls.some((call) => call.name === 'recover' || call.name === 'connect'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('logout closes visible session before awaiting the server and unknown failure never restores it', async () => {
  let finish!: (result: Awaited<ReturnType<SecureAccountApi>>) => void;
  const pending = new Promise<Awaited<ReturnType<SecureAccountApi>>>((resolve) => {
    finish = resolve;
  });
  const view = await mount(connected(), account, () => pending);
  try {
    assert.ok(view.document.querySelector('.secure-history'));
    await view.click('退出账号');
    assert.equal(view.document.querySelector('.secure-history'), null);
    assert.equal(view.document.querySelector('#secure-prompt'), null);
    assert.equal(view.document.querySelector('.secure-operations'), null);
    assert.equal(view.calls.at(-1)?.name, 'close');
    assert.deepEqual(view.accountCalls.at(-1), { action: 'logout' });
    assert.match(view.document.body.textContent!, /账号状态未确认/);
    await view.act(async () => {
      finish({ ok: false, error: { message: '退出结果待确认，请重新读取账号状态' } });
    });
    assert.match(view.document.querySelector('[role=alert]')!.textContent!, /退出结果待确认/);
    assert.equal(view.document.querySelector('.secure-history'), null);
    assert.equal(view.document.querySelector('#secure-prompt'), null);
    assert.equal(view.document.querySelector('.secure-operations'), null);
    assert.doesNotMatch(view.document.body.textContent!, /已退出|退出成功|合成会话/);
    assert.equal(view.button('重新读取').disabled, false);
  } finally {
    await view.cleanup();
  }
});
