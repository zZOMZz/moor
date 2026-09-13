import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { SecureAccountApi, SecureUiController } from '../src/web/secure-app';
import type { SecureWorkspaceState } from '../src/web/secure-controller';
import { sessionPermissionReviews } from '../src/session-client';
import { PERMISSION_REVIEW_FEATURE } from '../src/permission-review';
import { ATTACHMENTS_FEATURE } from '../src/attachment-protocol';
import { ATTACHMENT_OPERATIONS_FEATURE } from '../src/session-control-protocol';
import { createHash } from 'node:crypto';
import type { AttachmentReference } from '../src/content-protocol';

const pin = {
  serverOrigin: 'https://relay.synthetic.invalid',
  accountId: 'synthetic-owner',
  rootKeyId: 'A'.repeat(43),
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
    attachmentDraft: [],
    permissionReviews: [],
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
        features: [PERMISSION_REVIEW_FEATURE],
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
function permissionState(): SecureWorkspaceState {
  const state = connected();
  state.draft = '审批不应清除此草稿';
  state.session!.meta.latestUserMsgId = 'user-turn';
  state.session!.history = [
    {
      id: 'assistant-turn',
      $cid: 'synthetic-assistant',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: undefined,
      userTurnId: 'user-turn',
      status: 'working',
      read: undefined,
      finished: false,
      inputConfig: undefined,
      fileDiff: undefined,
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          title: '修改合成文件',
          kind: 'edit',
          status: 'pending',
          rawInput: {
            path: '/synthetic/project/example.ts',
            oldText: 'before',
            newText: '<script>unsafe()</script>',
          },
          permissionRequest: {
            requestId: 'request',
            options: [
              { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
              { optionId: 'reject', name: '拒绝一次', kind: 'reject_once' },
            ],
          },
        },
      ],
    },
  ];
  updatePermissionReviews(state);
  return state;
}
function updatePermissionReviews(state: SecureWorkspaceState) {
  const target = {
    origin: pin.serverOrigin,
    owner: pin.accountId,
    rootKeyId: pin.rootKeyId,
    clientDeviceId: 'client',
    hostDeviceId: 'host',
    workspaceId: 'runtime',
    localProjectId: 'local',
    userId: 'user',
    machineId: 'machine',
    sessionId: 'session',
    product: {
      catalogWorkspaceId: 'workspace',
      projectId: 'project',
      replicaId: 'replica',
      revision: 3,
    },
  };
  state.permissionReviews = sessionPermissionReviews(state.session!, {
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'runtime',
    localProjectId: 'local',
    sessionId: 'session',
  }).map((request) => ({ target, request }));
}
function permissionOperation(
  state: SecureWorkspaceState,
  lifecycle: 'pending' | 'ending' | 'accepted' | 'abandoned' = 'pending',
) {
  const review = state.permissionReviews[0];
  return {
    operationId: 'permission-original',
    kind: 'permission' as const,
    target: review.target,
    body: JSON.stringify({
      method: 'mutate',
      workspaceId: review.target.workspaceId,
      localProjectId: review.target.localProjectId,
      params: {
        kind: 'permission',
        operationId: 'permission-original',
        sessionId: review.target.sessionId,
        workspaceId: review.target.workspaceId,
        requestId: review.request.requestId,
        expectedTurnId: review.request.expectedUserTurnId,
        update: 'synthetic',
      },
    }),
    requestVersion: 'sha256:' + 'a'.repeat(64),
    state: lifecycle,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
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
    get contentContext() {
      const device = state.status?.device;
      const session = state.session;
      const replica = state.catalog?.products.replicas.find(
        (entry) => entry.id === state.replicaId,
      );
      if (!device || !('deviceId' in device) || !session || !replica)
        return { target: null, online: false, generation: 0 };
      return {
        target: {
          origin: device.pin.serverOrigin,
          owner: device.pin.accountId,
          rootKeyId: device.pin.rootKeyId,
          clientDeviceId: device.deviceId,
          hostDeviceId: state.hostId!,
          workspaceId: replica.runtimeWorkspaceId,
          localProjectId: replica.localProjectId,
          machineId: replica.machineId,
          userId: replica.userId,
          sessionId: session.meta.id,
          product: {
            catalogWorkspaceId: replica.catalogWorkspaceId,
            projectId: replica.projectId,
            replicaId: replica.id,
            revision: replica.revision,
          },
        },
        online: !!state.status?.connection,
        generation: 0,
      };
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
    'refreshAgentOptions',
    'createSession',
    'send',
    'respondPermission',
    'addAttachments',
    'removeAttachment',
    'readAttachment',
    'contentRequest',
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
    'NodeFilter',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'DOMRect',
    'KeyboardEvent',
  ])
    setGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
  setGlobal('window', dom.window);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  const animation = (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  const resize = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const media = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  setGlobal('requestAnimationFrame', animation);
  setGlobal('cancelAnimationFrame', () => {});
  setGlobal('ResizeObserver', resize);
  setGlobal('matchMedia', media);
  Object.assign(dom.window, {
    requestAnimationFrame: animation,
    cancelAnimationFrame() {},
    ResizeObserver: resize,
    matchMedia: media,
  });
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
      {
        name: 'send',
        args: [
          '只使用合成数据',
          { target: view.controller.contentContext.target, attachments: [] },
        ],
      },
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
    await view.click('封存原操作');
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
    assert.match(view.document.body.textContent!, /审批请求无法唯一核对/);
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

test('permission explicitly submits the complete displayed review and chosen original option safely', async () => {
  const state = permissionState();
  const view = await mount(state);
  try {
    assert.equal(state.permissionReviews.length, 1);
    assert.deepEqual(view.calls, [{ name: 'refreshStatus', args: [] }]);
    const panel = view.document.querySelector('.secure-permission')!;
    assert.match(panel.textContent!, /\/synthetic\/project\/example.ts/);
    assert.match(panel.textContent!, /<script>unsafe\(\)<\/script>/);
    assert.equal(panel.querySelector('script'), null);
    await view.click('允许一次');
    assert.deepEqual(view.calls.at(-1), {
      name: 'respondPermission',
      args: [state.permissionReviews[0], { outcome: 'selected', optionId: 'allow' }],
    });
    const supplied = view.calls.at(-1)!
      .args[0] as SecureWorkspaceState['permissionReviews'][number];
    assert.equal(Object.isFrozen(supplied), true);
    assert.equal(Object.isFrozen(supplied.request.options[0]), true);
    assert.equal(supplied.request.itemJson, state.permissionReviews[0].request.itemJson);
    assert.equal(
      view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!.value,
      state.draft,
    );
  } finally {
    await view.cleanup();
  }
});

test('changed approval content disables the previously displayed choice until explicit rereview', async () => {
  const state = permissionState();
  const view = await mount(state);
  try {
    const oldChoice = view.button('允许一次');
    const changed = structuredClone(state);
    const item = changed.session!.history[0].items![0] as any;
    item.rawInput.path = '/synthetic/project/changed.ts';
    item.permissionRequest.options[0].name = '允许修改新版文件';
    updatePermissionReviews(changed);
    await view.act(async () => view.update(changed));
    assert.equal(oldChoice.disabled, true);
    assert.match(
      view.document.querySelector('.secure-permission-details')!.textContent!,
      /example.ts/,
    );
    assert.doesNotMatch(
      view.document.querySelector('.secure-permission-details')!.textContent!,
      /changed.ts/,
    );
    await view.act(async () => oldChoice.click());
    assert.equal(
      view.calls.some((call) => call.name === 'respondPermission'),
      false,
    );
    assert.match(view.document.body.textContent!, /审批内容已改变/);
    await view.click('重新核对审批');
    assert.match(
      view.document.querySelector('.secure-permission-details')!.textContent!,
      /changed.ts/,
    );
    await view.click('允许修改新版文件');
    assert.deepEqual(view.calls.at(-1), {
      name: 'respondPermission',
      args: [changed.permissionReviews[0], { outcome: 'selected', optionId: 'allow' }],
    });
  } finally {
    await view.cleanup();
  }
});

test('cancel approval and sealing an original operation are separate explicit actions', async () => {
  const state = permissionState();
  const view = await mount(state);
  try {
    await view.click('取消审批请求');
    assert.deepEqual(view.calls.at(-1), {
      name: 'respondPermission',
      args: [state.permissionReviews[0], { outcome: 'cancelled' }],
    });
    const pending = { ...state, operations: [permissionOperation(state)] };
    await view.act(async () => view.update(pending));
    assert.equal(view.button('取消审批请求').disabled, true);
    assert.match(view.document.querySelector('.secure-operations')!.textContent!, /审批决定/);
    assert.match(
      view.document.querySelector('.secure-operations')!.textContent!,
      /不会取消主机等待的审批请求/,
    );
    await view.click('封存原操作');
    assert.deepEqual(view.calls.at(-1), {
      name: 'recover',
      args: ['permission-original', 'abandon'],
    });
    await view.act(async () =>
      view.update({ ...state, operations: [permissionOperation(state, 'abandoned')] }),
    );
    assert.equal(view.button('取消审批请求').disabled, false);
    assert.doesNotMatch(
      view.document.querySelector('.secure-permission')!.textContent!,
      /已取消审批请求/,
    );
  } finally {
    await view.cleanup();
  }
});

test('unknown permission delivery keeps its original record and draft and prevents a second decision', async () => {
  const state = permissionState();
  const view = await mount(state);
  try {
    view.controller.respondPermission = async (...args) => {
      view.calls.push({ name: 'respondPermission', args });
      view.update({
        ...state,
        operations: [permissionOperation(state)],
        notice: '原操作结果待确认，请手动核查',
      });
    };
    await view.click('拒绝一次');
    assert.equal(view.button('允许一次').disabled, true);
    assert.equal(view.button('取消审批请求').disabled, true);
    assert.equal(
      view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!.value,
      state.draft,
    );
    assert.match(
      view.document.querySelector('.secure-operations')!.textContent!,
      /permission-original/,
    );
    assert.match(view.document.body.textContent!, /原操作结果待确认/);
    await view.click('允许一次');
    assert.equal(view.calls.filter((call) => call.name === 'respondPermission').length, 1);
    await view.click('核查原操作');
    assert.deepEqual(view.calls.at(-1), {
      name: 'recover',
      args: ['permission-original', 'inspect'],
    });
  } finally {
    await view.cleanup();
  }
});

test('accepted permission receipt disables old choices while awaiting a manual outcome read', async () => {
  const state = permissionState();
  state.operations = [permissionOperation(state, 'accepted')];
  const view = await mount(state);
  try {
    assert.equal(view.button('允许一次').disabled, true);
    assert.equal(view.button('取消审批请求').disabled, true);
    assert.match(view.document.body.textContent!, /主机已接受此审批决定/);
    const read = structuredClone(state);
    (read.session!.history[0].items![0] as any).permissionRequest.outcome = {
      outcome: 'selected',
      optionId: 'allow',
    };
    updatePermissionReviews(read);
    await view.act(async () => view.update(read));
    assert.match(view.document.body.textContent!, /主机记录：已选择「允许一次」/);
    assert.equal(view.document.querySelector('.secure-permission-options'), null);
  } finally {
    await view.cleanup();
  }
});

test('permission decisions fail closed while offline, unpersisted, busy or no longer active', async () => {
  for (const mode of ['offline', 'unpersisted', 'busy', 'finished'] as const) {
    const state = permissionState();
    if (mode === 'offline') state.status!.connection = null;
    if (mode === 'unpersisted') state.session!.persisted = false;
    if (mode === 'busy') state.busy = true;
    if (mode === 'finished') state.session!.history[0].finished = true;
    updatePermissionReviews(state);
    const view = await mount(state);
    try {
      for (const choice of view.document.querySelectorAll<HTMLButtonElement>(
        '.secure-permission button',
      ))
        assert.equal(choice.disabled, true, mode);
      assert.equal(
        view.calls.some((call) => call.name === 'respondPermission'),
        false,
      );
    } finally {
      await view.cleanup();
    }
  }
});

test('ambiguous request/assistant identity and malformed options never expose an actionable approval', async () => {
  for (const mode of ['request', 'assistant', 'options', 'field'] as const) {
    const state = permissionState();
    const item = state.session!.history[0].items![0] as any;
    if (mode === 'request') state.session!.history[0].items!.push(structuredClone(item));
    if (mode === 'assistant')
      state.session!.history.push({
        ...structuredClone(state.session!.history[0]),
        id: 'another-assistant',
      });
    if (mode === 'options')
      item.permissionRequest.options.push(structuredClone(item.permissionRequest.options[0]));
    if (mode === 'field') item.permissionRequest.options[0].kind = 'unknown';
    updatePermissionReviews(state);
    const view = await mount(state);
    try {
      assert.equal(view.document.querySelector('.secure-permission-options'), null, mode);
      assert.match(view.document.body.textContent!, /审批请求无法唯一核对/);
      assert.equal(
        view.calls.some((call) => call.name === 'respondPermission'),
        false,
      );
    } finally {
      await view.cleanup();
    }
  }
});

test('one tool can show distinct permission requests and each click keeps its own request identity', async () => {
  const state = permissionState();
  const first = state.session!.history[0].items![0] as any;
  const second = structuredClone(first);
  second.permissionRequest.requestId = 'second-request';
  second.rawInput.path = '/synthetic/project/second.ts';
  state.session!.history[0].items!.push(second);
  updatePermissionReviews(state);
  assert.equal(state.permissionReviews.length, 2);
  const view = await mount(state);
  try {
    const cards = view.document.querySelectorAll('.secure-permission');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent!, /example.ts/);
    assert.match(cards[1].textContent!, /second.ts/);
    const choice = cards[1].querySelector<HTMLButtonElement>('.secure-permission-options button')!;
    assert.equal(choice.disabled, false);
    await view.act(async () => choice.click());
    assert.deepEqual(view.calls.at(-1), {
      name: 'respondPermission',
      args: [state.permissionReviews[1], { outcome: 'selected', optionId: 'allow' }],
    });
    assert.equal(view.calls.filter((call) => call.name === 'respondPermission').length, 1);
    const firstCancel = [...cards[0].querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '取消审批请求',
    )!;
    await view.act(async () => firstCancel.click());
    assert.deepEqual(view.calls.at(-1), {
      name: 'respondPermission',
      args: [state.permissionReviews[0], { outcome: 'cancelled' }],
    });
  } finally {
    await view.cleanup();
  }
});

test('hosts without exact permission capability remain readable and require upgrade before decisions', async () => {
  const state = permissionState();
  state.catalog!.workspaces[0].features = [];
  // Even a prior review retained by a caller cannot bypass the current Host capability.
  assert.equal(state.permissionReviews.length, 1);
  const view = await mount(state);
  try {
    assert.ok(view.document.querySelector('.secure-history'));
    assert.match(
      view.document.body.textContent!,
      /执行主机尚不支持精确审批校验，请升级主机后重新核对目录/,
    );
    assert.equal(view.document.querySelector('.secure-permission-options'), null);
    assert.equal(
      [...view.document.querySelectorAll('button')].some(
        (button) => button.textContent === '取消审批请求',
      ),
      false,
    );
    assert.equal(
      view.calls.some((call) => call.name === 'respondPermission'),
      false,
    );
    assert.equal(view.button('刷新会话').disabled, false);
  } finally {
    await view.cleanup();
  }
});

function attachmentFixture(
  type = 'text/plain',
  text = '合成附件 <script>no()</script>',
  id = 'attachment',
) {
  const bytes = Buffer.from(text);
  const reference: AttachmentReference = {
    contentVersion: 1,
    attachmentId: id,
    name: type.startsWith('audio/')
      ? 'synthetic.wav'
      : type.startsWith('image/')
        ? 'synthetic.png'
        : 'synthetic.txt',
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      mediaType: type,
    },
  };
  return { reference, data: bytes.toString('base64') };
}
function attachmentState() {
  const state = connected();
  state.catalog!.workspaces[0].features!.push(ATTACHMENTS_FEATURE, ATTACHMENT_OPERATIONS_FEATURE);
  state.session!.agent = {
    id: 'agent',
    name: '合成 Agent',
    cliType: 'synthetic',
    agentType: 'synthetic',
    inputCapabilities: { image: true, audio: true, embeddedContext: true },
  };
  state.attachmentDraft = [{ ...attachmentFixture(), status: 'draft' }];
  return state;
}

test('file selection and paste only add local attachment drafts without upload or execution', async () => {
  const view = await mount(connected());
  try {
    const win = view.document.defaultView!;
    const file = new win.File(['synthetic'], 'selected.txt', { type: 'text/plain' });
    const input = view.document.querySelector<HTMLInputElement>('.secure-attachment-input')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await view.act(async () => input.dispatchEvent(new win.Event('change', { bubbles: true })));
    const paste = new win.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    await view.act(async () => view.document.querySelector('#secure-prompt')!.dispatchEvent(paste));
    assert.equal(paste.defaultPrevented, true);
    assert.deepEqual(
      view.calls.slice(1).map((call) => call.name),
      ['addAttachments', 'addAttachments'],
    );
    assert.equal((view.calls[1].args[0] as File[])[0], file);
    assert.equal(
      view.calls.some((call) => call.name === 'send' || call.name === 'recover'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('attachment-only send freezes displayed scope and files before awaiting text draft persistence', async () => {
  const state = attachmentState();
  const view = await mount(state);
  let saved!: () => void;
  const saving = new Promise<void>((resolve) => {
    saved = resolve;
  });
  try {
    const shown = structuredClone(state.attachmentDraft);
    const target = structuredClone(view.controller.contentContext.target);
    view.controller.saveDraft = async () => saving;
    assert.equal(view.button('发送').disabled, false);
    await view.submit(view.document.querySelector<HTMLTextAreaElement>('#secure-prompt')!.form!);
    const newer = structuredClone(state);
    newer.attachmentDraft.push({
      ...attachmentFixture('text/plain', 'different', 'new-attachment'),
      status: 'draft',
    });
    await view.act(async () => view.update(newer));
    await view.act(async () => saved());
    assert.deepEqual(view.calls.at(-1), {
      name: 'send',
      args: ['', { target, attachments: shown }],
    });
  } finally {
    saved();
    await view.cleanup();
  }
});

test('pending attachment operations recover only original ids and remain blocked while seal is unconfirmed', async () => {
  const state = attachmentState();
  const draft = state.attachmentDraft[0];
  draft.status = 'pending';
  draft.pendingAction = 'upload';
  draft.pendingOperationId = 'upload-original';
  const fixture = fake(state);
  state.operations = [
    {
      operationId: 'upload-original',
      kind: 'attachment-upload',
      target: fixture.controller.contentContext.target!,
      body: '{}',
      requestVersion: 'sha256:' + 'b'.repeat(64),
      state: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const view = await mount(state);
  try {
    assert.equal(view.button('发送').disabled, true);
    const ledger = view.document.querySelector('.secure-operations')!;
    assert.match(ledger.textContent!, /上传附件/);
    assert.match(ledger.textContent!, /封存需主机确认/);
    await view.click('核查原操作');
    assert.deepEqual(view.calls.at(-1), { name: 'recover', args: ['upload-original', 'inspect'] });
    await view.click('使用原操作重试确认');
    assert.deepEqual(view.calls.at(-1), { name: 'recover', args: ['upload-original', 'retry'] });
    await view.click('封存原操作');
    assert.deepEqual(view.calls.at(-1), { name: 'recover', args: ['upload-original', 'abandon'] });
    const ending = structuredClone(state);
    ending.operations[0].state = 'ending';
    await view.act(async () => view.update(ending));
    assert.equal(view.button('使用原操作重试确认').disabled, true);
    assert.equal(view.button('重试原操作').disabled, true);
    assert.equal(view.button('核查原操作').disabled, false);
    assert.equal(view.button('封存原操作').disabled, false);
    assert.equal(view.button('发送').disabled, true);
    assert.equal(view.document.querySelector('[aria-label="移除附件草稿：synthetic.txt"]'), null);
    assert.equal(
      view.calls.some((call) => call.name === 'removeAttachment' || call.name === 'send'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('history and tool attachments read exact references and safely preview text without remote assets', async () => {
  const state = permissionState();
  const attachment = attachmentFixture();
  (state.session!.history[0].items![0] as any).content = [
    { type: 'attachment', attachment: attachment.reference },
  ];
  state.session!.history[0].items!.push({
    type: 'attachment',
    attachment: { ...attachment.reference, attachmentId: 'direct' },
  });
  updatePermissionReviews(state);
  const view = await mount(state);
  try {
    view.controller.readAttachment = async (reference) => {
      view.calls.push({ name: 'readAttachment', args: [reference] });
      return {
        target: view.controller.contentContext.target!,
        reference,
        data: attachment.data,
        source: 'host',
        cacheSaved: true,
      };
    };
    const cards = view.document.querySelectorAll<HTMLButtonElement>(
      '.secure-history .secure-attachment-card',
    );
    assert.equal(cards.length, 2);
    await view.act(async () => cards[0].click());
    assert.deepEqual(view.calls.at(-1), { name: 'readAttachment', args: [attachment.reference] });
    const preview = view.document.querySelector('.secure-attachment-preview')!;
    assert.match(preview.textContent!, /合成附件 <script>no\(\)<\/script>/);
    assert.equal(preview.querySelector('script, iframe, object'), null);
    assert.equal(preview.querySelector('img, audio'), null);
  } finally {
    await view.cleanup();
  }
});

test('changing the selected scope hides pending attachment data and cancels an in-progress native save', async () => {
  const state = attachmentState();
  const view = await mount(state);
  const saved: unknown[] = [];
  let cancel = 0,
    finishSave!: (result: { status: 'saved' }) => void;
  const waitingSave = new Promise<{ status: 'saved' }>((resolve) => {
    finishSave = resolve;
  });
  try {
    Object.assign(view.document.defaultView!, {
      moorDesktop: {
        version: 1,
        saveAttachment: (value: unknown) => {
          saved.push(value);
          return waitingSave;
        },
        cancelAttachmentSave: async () => {
          cancel++;
        },
      },
    });
    const previewButton = view.document.querySelector<HTMLButtonElement>(
      '[aria-label="预览附件草稿：synthetic.txt"]',
    )!;
    await view.act(async () => previewButton.click());
    await view.click('保存附件');
    assert.equal(saved.length, 1);
    assert.deepEqual((saved[0] as any).scope, {
      owner: pin.accountId,
      deviceId: 'host',
      workspaceId: 'runtime',
      localProjectId: 'local',
      sessionId: 'session',
    });
    const priorCancelled = cancel;
    const next = structuredClone(state);
    next.session!.meta.id = 'other-session';
    await view.act(async () => view.update(next));
    assert.equal(view.document.querySelector('.secure-attachment-preview'), null);
    assert(cancel > priorCancelled);
    await view.act(async () => finishSave({ status: 'saved' }));
    assert.equal(view.document.querySelector('.secure-attachment-preview'), null);
    assert.doesNotMatch(view.document.body.textContent!, /附件已保存/);
  } finally {
    finishSave({ status: 'saved' });
    await view.cleanup();
  }
});

test('project panel uses only frozen finite file reads and closes immediately on target changes', async (t) => {
  t.mock.method(crypto.subtle, 'digest', async (algorithm: string, bytes: Uint8Array) => {
    assert.equal(algorithm, 'SHA-256');
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
  });
  const view = await mount(connected());
  try {
    const text = '# 合成文件\n<script>no()</script>';
    const bytes = Buffer.from(text);
    const version = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    view.controller.contentRequest = async (target, method, params) => {
      view.calls.push({
        name: 'contentRequest',
        args: [structuredClone(target), method, structuredClone(params)],
      });
      const scope = {
        contentVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        confirmed: true,
      };
      if (method === 'read-project-tree')
        return {
          ...scope,
          version,
          source: 'directory',
          entries: [{ path: 'readme.md', type: 'file', size: bytes.byteLength }],
          offset: 0,
          total: 1,
          partial: false,
          enumerationComplete: true,
          issues: [],
        };
      if (method === 'file-content')
        return {
          ...scope,
          path: 'readme.md',
          status: 'content',
          encoding: 'base64',
          content: { version, byteLength: bytes.byteLength, mediaType: 'text/plain' },
          data: bytes.toString('base64'),
        };
      throw Error('Unexpected synthetic content method');
    };
    await view.click('项目文件');
    const file = view.document.querySelector<HTMLButtonElement>(
      '[aria-label="查看文件：readme.md"]',
    )!;
    assert.ok(file, view.document.body.textContent!);
    await view.act(async () => file.click());
    const panel = view.document.querySelector('.project-content-panel')!;
    assert.match(panel.textContent!, /合成文件/);
    assert.equal(panel.querySelector('script'), null);
    const calls = view.calls.filter((call) => call.name === 'contentRequest');
    assert.deepEqual(
      calls.map((call) => call.args[1]),
      ['read-project-tree', 'file-content'],
    );
    assert.deepEqual(calls[0].args[0], calls[1].args[0]);
    const next = connected();
    next.session!.meta.id = 'another-session';
    await view.act(async () => view.update(next));
    assert.equal(view.document.querySelector('.project-content-panel'), null);
    assert.equal(view.calls.filter((call) => call.name === 'contentRequest').length, 2);
  } finally {
    await view.cleanup();
  }
});

test('attachment previews use only safe inline media and audio never autoplays', async () => {
  for (const type of ['image/png', 'audio/wav', 'image/svg+xml', 'text/html']) {
    const state = attachmentState();
    state.attachmentDraft = [
      { ...attachmentFixture(type, '<script>synthetic</script>'), status: 'draft' },
    ];
    const view = await mount(state);
    try {
      const open = view.document.querySelector<HTMLButtonElement>(
        '.secure-attachment-drafts .secure-attachment-card',
      )!;
      await view.act(async () => open.click());
      const body = view.document.querySelector('.secure-attachment-preview-body')!;
      assert.equal(body.querySelector('script, iframe, object, embed'), null);
      if (type === 'image/png')
        assert.match(body.querySelector('img')!.src, /^data:image\/png;base64,/);
      else if (type === 'audio/wav') {
        const audio = body.querySelector('audio')!;
        assert.match(audio.src, /^data:audio\/wav;base64,/);
        assert.equal(audio.autoplay, false);
        assert.equal(audio.preload, 'none');
        assert.equal(audio.controls, true);
      } else {
        assert.equal(body.querySelector('img, audio'), null);
        assert.match(body.textContent!, /此格式不在页面中嵌入/);
      }
    } finally {
      await view.cleanup();
    }
  }
});

test('late attachment reads never restore bytes after the displayed session changes', async () => {
  const state = permissionState();
  const attachment = attachmentFixture('text/plain', '不得晚到展示的合成内容');
  state.session!.history[0].items = [{ type: 'attachment', attachment: attachment.reference }];
  const view = await mount(state);
  let finish!: (value: Awaited<ReturnType<SecureUiController['readAttachment']>>) => void;
  const pending = new Promise<Awaited<ReturnType<SecureUiController['readAttachment']>>>(
    (resolve) => {
      finish = resolve;
    },
  );
  const target = view.controller.contentContext.target!;
  try {
    view.controller.readAttachment = async () => pending;
    const card = view.document.querySelector<HTMLButtonElement>(
      '.secure-history .secure-attachment-card',
    )!;
    await view.act(async () => card.click());
    assert.match(view.document.body.textContent!, /正在读取并核对附件/);
    const next = connected();
    next.session!.meta.id = 'new-session';
    await view.act(async () => view.update(next));
    assert.equal(view.document.querySelector('.secure-attachment-preview'), null);
    await view.act(async () => finish({ ...attachment, target, source: 'host', cacheSaved: true }));
    assert.equal(view.document.querySelector('.secure-attachment-preview'), null);
    assert.doesNotMatch(view.document.body.textContent!, /不得晚到展示的合成内容/);
  } finally {
    finish({ ...attachment, target, source: 'host', cacheSaved: true });
    await view.cleanup();
  }
});

test('older attachment hosts keep local drafts available but cannot send or recover uploads', async () => {
  const state = attachmentState();
  state.catalog!.workspaces[0].features = [ATTACHMENTS_FEATURE];
  const view = await mount(state);
  try {
    assert.equal(view.button('发送').disabled, true);
    assert.equal(view.button('添加附件').disabled, false);
    assert.match(view.document.body.textContent!, /尚不支持可恢复的附件操作/);
    await view.click('移除');
    assert.deepEqual(view.calls.at(-1), { name: 'removeAttachment', args: ['attachment'] });
    const pending = structuredClone(state);
    pending.attachmentDraft[0].status = 'pending';
    pending.attachmentDraft[0].pendingOperationId = 'old-upload';
    pending.attachmentDraft[0].pendingAction = 'upload';
    pending.operations = [
      {
        operationId: 'old-upload',
        kind: 'attachment-upload',
        target: view.controller.contentContext.target!,
        body: '{}',
        requestVersion: 'sha256:' + 'b'.repeat(64),
        state: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    await view.act(async () => view.update(pending));
    for (const label of ['使用原操作重试确认', '核查原操作', '重试原操作', '封存原操作']) {
      assert.equal(view.button(label).disabled, true);
      await view.click(label);
    }
    assert.equal(
      view.calls.some((call) => call.name === 'recover' || call.name === 'send'),
      false,
    );
  } finally {
    await view.cleanup();
  }
});

test('checking attachment input capability binds the shown session and never uploads or sends', async () => {
  const state = attachmentState();
  delete state.session!.agent!.inputCapabilities;
  const view = await mount(state);
  try {
    const shownTarget = structuredClone(view.controller.contentContext.target!);
    assert.equal(view.button('发送').disabled, true);
    assert.equal(view.button('检查附件输入能力').disabled, false);
    assert.equal(
      view.calls.some((call) => call.name === 'refreshAgentOptions'),
      false,
    );
    await view.click('检查附件输入能力');
    assert.deepEqual(view.calls.at(-1), { name: 'refreshAgentOptions', args: [shownTarget] });
    assert.equal(
      view.calls.some(
        (call) => call.name === 'send' || call.name === 'recover' || call.name === 'addAttachments',
      ),
      false,
    );
    const capable = structuredClone(state);
    capable.session!.agent!.inputCapabilities = {
      image: true,
      audio: false,
      embeddedContext: true,
    };
    await view.act(async () => view.update(capable));
    assert.equal(view.button('发送').disabled, false);
    assert.equal(view.calls.filter((call) => call.name === 'refreshAgentOptions').length, 1);
    for (const variation of ['offline', 'busy', 'running']) {
      const next = structuredClone(state);
      if (variation === 'offline') next.status!.connection = null;
      if (variation === 'busy') next.busy = true;
      if (variation === 'running') next.session!.meta.status = { type: 'working' };
      await view.act(async () => view.update(next));
      assert.equal(view.button('检查附件输入能力').disabled, true, variation);
    }
  } finally {
    await view.cleanup();
  }
});
