import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { AccountApi } from '../../apps/web/src/platform/account';
import type { ManagedWorkspace } from '../../apps/web/src/features/auth/catalog-management';

const workspaces: ManagedWorkspace[] = [
  {
    id: 'workspace-a',
    name: 'Workspace A',
    hosts: [
      {
        id: 'host-a',
        name: 'Computer A',
        deviceId: 'device-a',
        machineId: 'machine-a',
        runtimeWorkspaceId: 'runtime-a',
        online: true,
        agents: [],
      },
    ],
    projects: [
      { id: 'project-a', name: 'Project A' },
      { id: 'project-b', name: 'Project B' },
    ],
    replicas: [
      {
        id: 'replica-a',
        projectId: 'project-a',
        hostId: 'host-a',
        localProjectId: 'local-a',
        available: true,
      },
    ],
  },
  { id: 'workspace-b', name: 'Workspace B', hosts: [], projects: [], replicas: [] },
];
const target = {
  serverKey: 'https://synthetic.invalid',
  owner: 'owner-a',
  deviceId: 'device-a',
  workspaceId: 'runtime-a',
  machineId: 'machine-a',
  userId: 'user-a',
  localProjectId: 'local-a',
  catalogWorkspaceId: 'workspace-a',
  catalogProjectId: 'project-a',
  replicaId: 'replica-a',
};

async function fixture(t: TestContext) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://synthetic.invalid' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLFormElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'navigator',
    'FormData',
    'location',
    'localStorage',
  ])
    set(key, (dom.window as any)[key]);
  set('indexedDB', { databases: async () => [] });
  set('IS_REACT_ACT_ENVIRONMENT', true);
  const { createElement, act } = await import('react'),
    { createRoot } = await import('react-dom/client');
  const { WorkspaceAccountPanel } =
    await import('../../apps/web/src/features/auth/workspace-account');
  const root = createRoot(dom.window.document.getElementById('app')!);
  const requests: Parameters<AccountApi>[0][] = [],
    confirmations: string[] = [];
  let confirm = true,
    failMove = false,
    changes = 0,
    statusOwner = 'owner-a';
  let managedWorkspaces = structuredClone(workspaces),
    catalogWait: Promise<void> | undefined;
  dom.window.confirm = (message) => {
    confirmations.push(message ?? '');
    return confirm;
  };
  dom.window.addEventListener('moor:catalog-changed', () => changes++);
  const accountApi: AccountApi = async (request) => {
    requests.push(structuredClone(request));
    if (request.action === 'status')
      return {
        ok: true,
        value: {
          origin: dom.window.location.origin,
          owner: statusOwner,
          needsSetup: false,
          google: { enabled: false },
        },
      };
    if (request.action === 'catalog') {
      await catalogWait;
      return {
        ok: true,
        value: { action: 'catalog', workspaces: structuredClone(managedWorkspaces) },
      };
    }
    if (request.action === 'devices')
      return {
        ok: true,
        value: {
          action: 'devices',
          devices: [{ id: 'device-a', name: 'Computer A', online: true }],
        },
      };
    if (request.action === 'pair')
      return { ok: true, value: { action: 'pair', code: 'synthetic1234567', expiresIn: 300 } };
    if (request.action === 'move-host' && failMove)
      return { ok: false, error: { message: '结果待确认，请重新读取核对。' } };
    if (request.action === 'create-workspace' || request.action === 'create-project')
      return { ok: true, value: { action: request.action, id: 'created' } };
    if (request.action === 'logout')
      return request.owner === statusOwner
        ? { ok: true, value: { loggedOut: true } }
        : { ok: false, error: { message: '账号已改变，未退出当前账号。' } };
    return { ok: true, value: { action: request.action, ok: true } };
  };
  const props = { accountApi, onAccountVerified() {}, onBeforeLogout: async () => {}, onBack() {} };
  const render = async (extra: Partial<Parameters<typeof WorkspaceAccountPanel>[0]> = {}) => {
    await act(async () =>
      root.render(createElement(WorkspaceAccountPanel, { ...props, ...extra })),
    );
  };
  const button = (label: string) => {
    const result = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    );
    assert(result, label);
    return result;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const submit = async (label: string, values: Record<string, string>) => {
    const form = button(label).closest('form')!;
    for (const [name, value] of Object.entries(values))
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    await act(async () =>
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
  };
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved)
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key);
  });
  await render();
  return {
    accountApi,
    setWorkspaces: (value: ManagedWorkspace[]) => {
      managedWorkspaces = structuredClone(value);
    },
    waitForCatalog: (value: Promise<void>) => {
      catalogWait = value;
    },
    setOwner: (owner: string) => {
      statusOwner = owner;
    },
    dom,
    requests,
    confirmations,
    render,
    button,
    click,
    submit,
    act,
    setConfirm: (value: boolean) => {
      confirm = value;
    },
    setFailMove: () => {
      failMove = true;
    },
    changes: () => changes,
  };
}

test('shared account panel pairs and explicitly revokes a computer with the verified owner', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.requests, [{ action: 'status' }]);
  await f.render({ pairingScope: { source: 'remote', target } });
  await f.click('添加电脑');
  assert(
    !f.requests.some((request) => request.action === 'pair'),
    'multiple workspaces require an explicit choice',
  );
  assert.equal(
    f.dom.window.document.querySelector<HTMLSelectElement>('[aria-label="配对工作区"]')?.value,
    'workspace-a',
  );
  await f.click('生成配对码');
  assert.equal(f.dom.window.document.querySelector('output')?.textContent, 'synthetic1234567');
  assert.deepEqual(f.requests.at(-1), {
    action: 'pair',
    owner: 'owner-a',
    workspaceId: 'workspace-a',
  });
  await f.click('已连接电脑');
  f.setConfirm(false);
  await f.click('撤销授权');
  assert(!f.requests.some((request) => request.action === 'revoke'));
  f.setConfirm(true);
  await f.click('撤销授权');
  assert.deepEqual(
    f.requests.find((request) => request.action === 'revoke'),
    { action: 'revoke', owner: 'owner-a', deviceId: 'device-a' },
  );
  assert.equal(f.changes(), 1);
});

test('advanced grouping retains workspace naming and optional Git metadata without execution', async (t) => {
  const f = await fixture(t);
  await f.click('高级分组管理');
  await f.submit('创建工作区', { name: 'Third space' });
  await f.submit('保存工作区名称', { name: 'Renamed workspace' });
  const checkbox = f.dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await f.act(async () => checkbox.click());
  await f.submit('创建项目分组', {
    name: 'Git project',
    provider: 'github',
    url: 'https://github.com/synthetic/example',
  });
  assert.deepEqual(
    f.requests.find((request) => request.action === 'create-project'),
    {
      action: 'create-project',
      owner: 'owner-a',
      workspaceId: 'workspace-a',
      name: 'Git project',
      source: { kind: 'git', provider: 'github', url: 'https://github.com/synthetic/example' },
    },
  );
  assert.deepEqual(
    f.requests.find((request) => request.action === 'rename-workspace'),
    {
      action: 'rename-workspace',
      owner: 'owner-a',
      workspaceId: 'workspace-a',
      name: 'Renamed workspace',
    },
  );
  assert.equal(f.changes(), 3);
});

test('routing actions require confirmation and never retry an uncertain write', async (t) => {
  const f = await fixture(t);
  await f.click('高级分组管理');
  f.setConfirm(false);
  await f.submit('更改归属', { workspaceId: 'workspace-b' });
  assert(!f.requests.some((request) => request.action === 'move-host'));
  assert.equal(f.changes(), 0);
  f.setConfirm(true);
  await f.submit('保存项目归组', { projectId: 'project-b' });
  assert.deepEqual(
    f.requests.find((request) => request.action === 'assign-replica'),
    {
      action: 'assign-replica',
      owner: 'owner-a',
      workspaceId: 'workspace-a',
      replicaId: 'replica-a',
      projectId: 'project-b',
    },
  );
  f.setFailMove();
  await f.submit('更改归属', { workspaceId: 'workspace-b' });
  assert.equal(f.requests.filter((request) => request.action === 'move-host').length, 1);
  assert.match(f.dom.window.document.querySelector('[role="alert"]')!.textContent!, /待确认/);
  await f.click('重新读取分组');
  assert.equal(f.requests.filter((request) => request.action === 'move-host').length, 1);
});

test('a routing action rechecks the current selection and visibility after async draft flush', async (t) => {
  const f = await fixture(t);
  await f.render({ activeTarget: target });
  await f.click('高级分组管理');
  await f.submit('更改归属', { workspaceId: 'workspace-b' });
  assert.match(f.dom.window.document.querySelector('[role="alert"]')!.textContent!, /结束当前查看/);
  assert.equal(f.confirmations.length, 0);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await f.render({ beforeMove: () => waiting });
  await f.submit('保存项目归组', { projectId: 'project-b' });
  await f.render({ beforeMove: () => waiting, visible: false });
  await f.act(async () => release());
  assert(!f.requests.some((request) => request.action === 'assign-replica'));
  assert.equal(f.confirmations.length, 0);
});

test('logout retains the reviewed owner across draft flush and cannot sign out a newly verified account', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onBeforeLogout = () => waiting;
  await f.render({ onBeforeLogout });
  await f.click('退出账号');
  assert(!f.requests.some((request) => request.action === 'logout'));
  f.setOwner('owner-b');
  await f.render({ onBeforeLogout, accountApi: (request) => f.accountApi(request) });
  await f.act(async () => release());
  assert.deepEqual(
    f.requests.filter((request) => request.action === 'logout'),
    [{ action: 'logout', owner: 'owner-a' }],
  );
  assert.match(
    f.dom.window.document.querySelector('[role="alert"]')!.textContent!,
    /未退出当前账号/,
  );
  assert(f.button('退出账号'), 'the newly verified account remains signed in');
});

test('one remote workspace pairs directly, while a local or foreign scope cannot select a remote destination', async (t) => {
  const f = await fixture(t);
  f.setWorkspaces(workspaces.slice(0, 1));
  await f.render({ pairingScope: { source: 'local', target } });
  await f.click('添加电脑');
  assert.deepEqual(f.requests.at(-1), {
    action: 'pair',
    owner: 'owner-a',
    workspaceId: 'workspace-a',
  });
  assert.equal(f.dom.window.document.querySelector('[aria-label="配对工作区"]'), null);
  f.setWorkspaces(workspaces);
  for (const scope of [
    { source: 'local' as const, target },
    { source: 'remote' as const, target: { ...target, serverKey: 'https://other.invalid' } },
    { source: 'remote' as const, target: { ...target, owner: 'other-owner' } },
  ]) {
    await f.render({ pairingScope: scope });
    await f.click('添加电脑');
    assert.equal(
      f.dom.window.document.querySelector<HTMLSelectElement>('[aria-label="配对工作区"]')!.value,
      '',
    );
    assert(f.button('生成配对码').disabled);
    await f.click('取消配对');
  }
  assert.equal(f.requests.filter((request) => request.action === 'pair').length, 1);
  await f.click('添加电脑');
  const select =
    f.dom.window.document.querySelector<HTMLSelectElement>('[aria-label="配对工作区"]')!;
  await f.act(async () => {
    select.value = 'workspace-b';
    select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  });
  await f.click('生成配对码');
  assert.deepEqual(f.requests.at(-1), {
    action: 'pair',
    owner: 'owner-a',
    workspaceId: 'workspace-b',
  });
});

test('switching account during pairing catalog read never dispatches the old account pair request', async (t) => {
  const f = await fixture(t);
  f.setWorkspaces(workspaces.slice(0, 1));
  let release!: () => void;
  f.waitForCatalog(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await f.click('添加电脑');
  f.setOwner('owner-b');
  await f.render({ accountApi: (request) => f.accountApi(request) });
  await f.act(async () => release());
  assert(!f.requests.some((request) => request.action === 'pair'));
  assert.equal(f.dom.window.document.querySelector('output'), null);
});
