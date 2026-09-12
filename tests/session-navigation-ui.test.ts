import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Workspace } from '../src/catalog';
import type { SessionSummary } from '../src/web/navigation';
import type { Navigation, SessionActionKind } from '../src/web/ui';

test('session menus, host-confirmed rename, archive filters and long lists work inside the mobile drawer', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const win = dom.window;
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
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
    'localStorage',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : (win as any)[name],
    });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      queueMicrotask(() => fn(0));
      return 1;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  Object.assign(win, {
    matchMedia: globalThis.matchMedia,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  });
  const { act } = await import('react');
  const { showShell, showNavigation, disposeUI } = await import('../src/web/ui');
  const space = {
    id: 'w',
    name: 'Synthetic workspace',
    createdAt: 1,
    projects: [{ id: 'p', name: 'Synthetic project' }],
    replicas: [],
    hosts: [],
  } as unknown as Workspace;
  const session: SessionSummary = {
    id: 's',
    replicaId: 'r',
    projectId: 'p',
    title: 'Original title',
    metadataRevision: 0,
  };
  const actions: [string, SessionActionKind, string | undefined][] = [];
  const revisions: (number | undefined)[] = [];
  const selected: [string, string | undefined][] = [];
  const archives: boolean[] = [];
  let props: Parameters<typeof Navigation>[0] = {
    catalog: [space],
    space,
    projectLabels: { p: 'Synthetic project' },
    list: [session],
    projectFilter: '',
    search: '',
    selectedSession: 's',
    selectedReplica: 'r',
    connected: true,
    localOnly: false,
    canCreate: true,
    onWorkspace() {},
    onHost() {},
    onSearch() {},
    onProject() {},
    onNew() {},
    onManage() {},
    onPair() {},
    onLogout() {},
    onSession(id, replicaId) {
      selected.push([id, replicaId]);
    },
    onArchived(value) {
      archives.push(value);
    },
    onAction(value, action, title) {
      actions.push([value.id, action, title]);
      revisions.push(value.metadataRevision);
    },
    canManage: () => true,
  };
  const render = async (changes: Partial<typeof props>) => {
    props = { ...props, ...changes };
    await act(async () => showNavigation(props));
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  const namedButton = (label: string) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === label || button.textContent === label,
    );
    assert.ok(result, label);
    return result;
  };
  const menuItem = (name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent === name,
    );
    assert.ok(item, name);
    return item;
  };
  const escape = async () => {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
  };
  const titleInput = () => document.querySelector<HTMLInputElement>('#session-title-draft')!;
  const changeTitle = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(
        titleInput(),
        value,
      );
      titleInput().dispatchEvent(new win.Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => {
      showShell({ onSend() {}, onDraft() {}, onCancel() {} });
      showNavigation(props);
    });
    await click(namedButton('选择工作区和会话'));
    await click(document.querySelector<HTMLElement>('.session')!);
    assert.deepEqual(
      selected,
      [['s', 'r']],
      'list selection keeps the session and replica identity',
    );
    const trigger = namedButton('管理会话：Original title');
    assert.equal(
      trigger.closest('button.session'),
      null,
      'the row action is separate from the session button',
    );
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    assert.ok(menuItem('重命名'), 'keyboard opens the row menu');
    assert.equal(selected.length, 1, 'opening a menu never selects a different session');
    await click(menuItem('重命名'));
    assert.ok(document.querySelector('.session-dialog'));
    assert.equal(
      document.activeElement,
      titleInput(),
      'rename focuses its title field inside the nested dialog',
    );
    await changeTitle('  Edited draft  ');
    await render({
      list: [{ ...session, title: 'Remote title', metadataRevision: 1 }],
      listLoading: true,
    });
    assert.equal(
      titleInput().value,
      '  Edited draft  ',
      'a background refresh preserves the local title draft',
    );
    assert.ok(
      document.querySelector('#navigation[data-open]'),
      'the mobile drawer remains open beneath rename',
    );
    await click(namedButton('保存标题'));
    assert.deepEqual(actions, [['s', 'rename', 'Edited draft']]);
    assert.equal(
      revisions.at(-1),
      0,
      'the first save retains the revision from opening the dialog despite a remote refresh',
    );
    assert.equal(
      document.querySelector('.session-title')?.textContent,
      'Remote title',
      'the list waits for host confirmation',
    );
    await render({ actionPending: true, listLoading: false });
    assert.equal(namedButton('保存标题').disabled, true);
    assert.equal(titleInput().disabled, true);
    await render({
      actionPending: false,
      actionError: '网络中断，结果待确认',
      canManage: () => false,
    });
    assert.equal(
      namedButton('保存标题').disabled,
      true,
      'unknown delivery cannot rebase or send another operation',
    );
    await click(namedButton('保存标题'));
    assert.equal(
      actions.length,
      1,
      'unknown delivery retains the original operation for the controller to retry',
    );
    await render({ actionError: '名称修改失败，请重试', canManage: () => true });
    assert.equal(titleInput().value, '  Edited draft  ', 'rejected changes preserve their draft');
    assert.match(
      document.querySelector('.session-dialog [role="alert"]')?.textContent ?? '',
      /修改失败/,
    );
    await changeTitle('Edited draft');
    await click(namedButton('保存标题'));
    assert.equal(actions.length, 2, 'a known rejection can be retried explicitly');
    assert.equal(
      revisions.at(-1),
      1,
      'only an explicit save after known rejection may use the refreshed revision, even after editing the draft',
    );
    await render({
      list: [{ ...session, title: 'Edited draft', metadataRevision: 2 }],
      actionError: undefined,
    });
    assert.equal(document.querySelector('.session-dialog'), null, 'confirmed title closes rename');
    assert.equal(document.activeElement, namedButton('管理会话：Edited draft'));
    assert.ok(
      document.querySelector('#navigation[data-open]'),
      'closing rename does not close navigation',
    );

    await click(namedButton('管理会话：Edited draft'));
    await click(menuItem('重命名'));
    await changeTitle('');
    assert.equal(namedButton('保存标题').disabled, true, 'empty titles cannot be submitted');
    await changeTitle('   ');
    assert.equal(
      namedButton('保存标题').disabled,
      true,
      'whitespace-only titles cannot be submitted',
    );
    await escape();
    assert.equal(
      document.activeElement,
      namedButton('管理会话：Edited draft'),
      'Escape restores the row action trigger',
    );
    assert.ok(document.querySelector('#navigation[data-open]'));
    assert.equal(actions.length, 2, 'canceling rename does not send an action');

    await click(namedButton('管理会话：Edited draft'));
    await click(menuItem('置顶'));
    assert.deepEqual(actions.at(-1), ['s', 'pin', undefined]);
    assert.equal(
      document.querySelector('[aria-label="已置顶"]'),
      null,
      'pins wait for the host result',
    );
    await render({ list: [{ ...session, title: 'Edited draft', isPinned: true }] });
    assert.ok(document.querySelector('[aria-label="已置顶"]'));
    await click(namedButton('管理会话：Edited draft'));
    await click(menuItem('取消置顶'));
    assert.deepEqual(actions.at(-1), ['s', 'unpin', undefined]);
    await click(namedButton('管理会话：Edited draft'));
    await click(menuItem('归档'));
    assert.deepEqual(actions.at(-1), ['s', 'archive', undefined]);
    assert.ok(
      document.querySelector('.session'),
      'archive does not remove a row before confirmation',
    );

    await render({ list: [{ ...session, status: { type: 'working' } }] });
    await click(namedButton('管理会话：Original title'));
    const archive = menuItem('运行中，暂不可归档');
    assert.equal(archive.getAttribute('aria-disabled'), 'true');
    const actionCount = actions.length;
    await click(archive);
    assert.equal(actions.length, actionCount, 'running sessions cannot be archived');
    await escape();
    await render({ canManage: () => false });
    assert.equal(
      namedButton('管理会话：Original title').disabled,
      true,
      'offline or unresolved operations disable session management',
    );
    await click(namedButton('管理会话：Original title'));
    assert.equal(document.querySelector('[role="menu"]'), null);

    await click(namedButton('已归档'));
    assert.deepEqual(archives, [true]);
    assert.equal(
      namedButton('活跃会话').getAttribute('aria-pressed'),
      'true',
      'the archive filter is controlled',
    );
    await render({
      archived: true,
      canManage: () => true,
      list: [{ ...session, isArchived: true }],
    });
    assert.equal(document.querySelector('#sessions')?.getAttribute('aria-label'), '已归档会话列表');
    await click(namedButton('管理会话：Original title'));
    await click(menuItem('恢复会话'));
    assert.deepEqual(actions.at(-1), ['s', 'restore', undefined]);
    await click(namedButton('活跃会话'));
    assert.deepEqual(archives, [true, false]);

    await render({ list: [] });
    assert.match(document.querySelector('#sessions')?.textContent ?? '', /还没有归档/);
    await render({ archived: false, search: 'Original', list: [session] });
    await click(namedButton('管理会话：Original title'));
    await click(menuItem('重命名'));
    await changeTitle('Filtered out');
    await click(namedButton('保存标题'));
    await render({
      list: [],
      actionSession: { ...session, title: 'Remote change', metadataRevision: 3 },
      actionError: '另一台设备已更新此会话',
    });
    assert.equal(
      titleInput().value,
      'Filtered out',
      'a conflict can remove the row from search while retaining the draft',
    );
    await click(namedButton('保存标题'));
    assert.equal(
      revisions.at(-1),
      3,
      'manual retry uses the refreshed unfiltered session revision',
    );
    await render({
      actionSession: { ...session, title: 'Filtered out', metadataRevision: 4 },
      actionError: undefined,
    });
    assert.equal(
      document.querySelector('.session-dialog'),
      null,
      'host confirmation also closes rename when the row no longer matches search',
    );
    assert.equal(
      document.activeElement,
      document.querySelector('#session-search'),
      'a removed row returns focus within the mobile drawer',
    );
    await render({ search: '', actionSession: undefined });
    await render({ archived: false, listLoading: true });
    assert.equal(document.querySelector('#sessions')?.getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(document.querySelector('#sessions')?.textContent ?? '', /从一段新会话/);
    await render({ listLoading: false, listError: '电脑离线，会话刷新失败' });
    assert.match(document.querySelector('#sessions [role="alert"]')?.textContent ?? '', /刷新失败/);

    const longList: SessionSummary[] = Array.from({ length: 2000 }, (_, index) => ({
      ...session,
      id: `s-${index}`,
      title: `Synthetic ${index}`,
    }));
    await render({ list: longList, listError: undefined, selectedSession: 's-1999' });
    assert.equal(
      document.querySelectorAll('#sessions .session').length,
      101,
      'only the first page and selected session are rendered',
    );
    assert.equal(
      document.querySelectorAll('#sessions button').length,
      203,
      'large catalogs have a bounded initial set of navigation controls',
    );
    assert.match(
      document.querySelector('.session[aria-current="page"]')?.textContent ?? '',
      /Synthetic 1999/,
    );
    await click(document.querySelector<HTMLElement>('.session[aria-current="page"]')!);
    assert.deepEqual(
      selected.at(-1),
      ['s-1999', 'r'],
      'a selection outside the initial page remains reachable',
    );
    await click(document.querySelector<HTMLElement>('.load-more')!);
    assert.equal(document.querySelectorAll('#sessions .session').length, 201);
    await render({ connected: false });
    assert.equal(
      document.querySelectorAll('#sessions .session').length,
      201,
      'background updates retain the expanded page',
    );
    await render({ search: 'Synthetic' });
    assert.equal(
      document.querySelectorAll('#sessions .session').length,
      101,
      'changing the filter resets pagination while retaining selection',
    );
    await click(namedButton('关闭会话列表'));
    assert.equal(document.activeElement, namedButton('选择工作区和会话'));
  } finally {
    await act(async () => disposeUI());
    dom.window.close();
  }
});
