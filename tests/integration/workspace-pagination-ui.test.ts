import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { paginationFixture, signal } from '../fixtures/workspace-pagination';

test('React navigation consumes bounded summaries, cursors, server search and archive pages without unrelated reloads', async (t) => {
  const f = await paginationFixture(t);
  const originalRows = structuredClone(f.rows);
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
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
    'HTMLTextAreaElement',
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
  ])
    set(
      key,
      key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key],
    );
  set('IS_REACT_ACT_ENVIRONMENT', true);
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  const animation = (work: FrameRequestCallback) => {
    queueMicrotask(() => work(0));
    return 1;
  };
  const resize = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  set('requestAnimationFrame', animation);
  set('cancelAnimationFrame', () => {});
  set('ResizeObserver', resize);
  set('matchMedia', media);
  Object.assign(dom.window, {
    requestAnimationFrame: animation,
    cancelAnimationFrame() {},
    ResizeObserver: resize,
    matchMedia: media,
  });
  const React = await import('react'),
    { createRoot } = await import('react-dom/client');
  const {
    NavigationProjectGroup,
    NavigationSessions,
    navigationProjects,
    projectKey,
    useNavigationSessions,
  } = await import('../../apps/web/src/features/sessions/workspace-navigation');
  const root = createRoot(dom.window.document.getElementById('app')!);
  let refreshing: Promise<void> | undefined;
  let more: Promise<boolean> | undefined;
  const openings: { replicaId: string; projectId: string; sessionId: string }[] = [];
  function View({ query = '' }: { query?: string }) {
    const [state, setState] = React.useState(f.controller.state);
    React.useEffect(() => f.controller.subscribe(() => setState(f.controller.state)), []);
    const projects = navigationProjects(state),
      nav = useNavigationSessions(f.controller, state, projects, query);
    const entries = projects.flatMap((project) =>
      (nav.sessions[projectKey(project)] ?? [])
        .filter((session) => !session.isPinned)
        .map((session) => ({ project, session })),
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(NavigationSessions, {
        kind: 'recent',
        entries: entries.slice(0, 30),
        disabled: false,
        more: nav.summaries.recent.more,
        loading: nav.summaries.recent.loading,
        cached: nav.summaries.recent.cached,
        error: nav.summaries.recent.error,
        onLoadMore: () => {
          more = nav.loadMore('recent');
        },
        onRefresh: () => nav.refresh('recent'),
        onOpen(project, session) {
          openings.push({
            replicaId: project.target.replicaId,
            projectId: project.target.localProjectId,
            sessionId: session.id,
          });
        },
        onAction() {},
      }),
      ...projects.map((project) =>
        React.createElement(NavigationProjectGroup, {
          key: projectKey(project),
          project,
          controller: f.controller,
          revision: f.controller.projectRevision(project.source, project.target),
          sessions: nav.sessions[projectKey(project)],
          selected: false,
          disabled: false,
          query,
          unavailable: nav.unavailable.includes(projectKey(project)),
          onOpen(project, session) {
            openings.push({
              replicaId: project.target.replicaId,
              projectId: project.target.localProjectId,
              sessionId: session.id,
            });
          },
          onAction() {},
          onCreate() {},
          onRefresh: (item) => {
            refreshing = f.controller.refreshProjectSessions(item.source, item.target);
          },
        }),
      ),
    );
  }
  const group = (id: string) =>
    dom.window.document.querySelector<HTMLElement>(`section[aria-label="${id}"]`)!;
  const button = (parent: ParentNode, label: string) => {
    const found = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) =>
        element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
    );
    assert(found, 'Missing button: ' + label);
    return found;
  };
  const reads = (id: string) =>
    f
      .listCalls()
      .filter((request) => request.action === 'execute' && request.target.localProjectId === id);
  try {
    const targets = navigationProjects(f.controller.state);
    const duplicateEntries = targets.map((project, index) => ({
      project: {
        ...project,
        source: 'remote' as const,
        hostName: `Mac ${index}`,
        target: {
          ...project.target,
          serverKey: 'https://synthetic.invalid',
          deviceId: `device-${index}`,
          machineId: `machine-${index}`,
        },
      },
      session: {
        ...f.rows[index]!,
        id: 'shared-session-id',
        machineId: `machine-${index}`,
        project: { kind: 'local' as const, localProjectId: project.target.localProjectId },
      },
    }));
    const exactTargets: unknown[] = [];
    await React.act(async () =>
      root.render(
        React.createElement(NavigationSessions, {
          kind: 'recent',
          entries: duplicateEntries,
          disabled: false,
          onOpen: (project, session) =>
            exactTargets.push({ target: project.target, sessionId: session.id }),
          onAction() {},
        }),
      ),
    );
    const duplicateButtons = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>('.workspace-session-open'),
    ];
    assert.equal(duplicateButtons.length, 2);
    for (const entry of duplicateButtons) await React.act(async () => entry.click());
    assert.deepEqual(
      exactTargets,
      duplicateEntries.map((entry) => ({
        target: entry.project.target,
        sessionId: 'shared-session-id',
      })),
      'same session ids on two computers retain each complete execution target',
    );
    await React.act(async () => root.render(React.createElement(View)));
    assert.equal(f.listCalls().length, 4, 'two bounded summaries per project');
    for (const call of f.listCalls()) {
      assert(call.action === 'execute' && call.command.method === 'sessions-page');
      assert.equal(call.command.params.limit, 30);
      assert(['pinned', 'unpinned'].includes(call.command.params.pinned));
    }
    const baseline = f.listCalls().length;
    await React.act(async () => f.controller.refreshCatalog('local'));
    assert.equal(f.listCalls().length, baseline, 'unchanged catalog does not reread all projects');
    const aReads = reads('project-a').length;
    for (const target of f.catalog.targets)
      target.runtime.projects.find((project) => project.id === 'project-b')!.rootPath =
        '/synthetic/moved-b';
    await React.act(async () => f.controller.refreshCatalog('local'));
    assert.equal(reads('project-a').length, aReads);
    assert.equal(reads('project-b').length, 4);

    const a = group('project-a');
    await React.act(async () => a.querySelector<HTMLButtonElement>('.workspace-project')!.click());
    assert.equal(a.querySelectorAll('ul > li').length, 30);
    assert.deepEqual(
      f.rows,
      originalRows,
      'navigation summaries never sort or mutate shared metadata in place',
    );
    await React.act(async () =>
      a.querySelector<HTMLButtonElement>('.workspace-session-open')!.click(),
    );
    const b = group('project-b');
    await React.act(async () => b.querySelector<HTMLButtonElement>('.workspace-project')!.click());
    await React.act(async () =>
      b.querySelector<HTMLButtonElement>('.workspace-session-open')!.click(),
    );
    assert.deepEqual(
      openings,
      [
        {
          replicaId: 'replica-project-a',
          projectId: 'project-a',
          sessionId: 'project-a-session-094',
        },
        {
          replicaId: 'replica-project-b',
          projectId: 'project-b',
          sessionId: 'project-b-session-094',
        },
      ],
      'clicking a project row preserves the exact selected project and replica',
    );
    assert.equal(
      f.controller.state.scope,
      undefined,
      'expansion never navigates or writes a draft',
    );
    await React.act(async () => button(a, '加载更多会话').click());
    assert.equal(a.querySelectorAll('ul > li').length, 60);
    const cursorCall = reads('project-a').at(-1)!;
    assert(
      cursorCall.action === 'execute' &&
        cursorCall.command.method === 'sessions-page' &&
        cursorCall.command.params.cursor,
    );

    f.failures.set('project-a', {
      code: 'network',
      status: null,
      rejected: false,
      message: 'Synthetic disconnect',
    });
    await React.act(async () => button(a, '加载更多会话').click());
    assert.equal(a.querySelectorAll('ul > li').length, 60);
    assert.match(a.textContent!, /下一页尚未缓存/);
    assert.match(a.textContent!, /已缓存的 60 项/);
    assert.equal(button(a, '在 project-a 中新建对话').disabled, true);
    f.failures.clear();
    const bReads = reads('project-b').length;
    await React.act(async () => {
      button(a, '重新读取').click();
      await refreshing;
    });
    assert.equal(a.querySelectorAll('ul > li').length, 30);
    assert.equal(
      reads('project-b').length,
      bReads,
      'manual project refresh leaves its neighbor alone',
    );

    assert.doesNotMatch(a.textContent!, /Needle far session/);
    await React.act(async () => root.render(React.createElement(View, { query: 'project-a' })));
    assert.equal(
      group('project-a').querySelectorAll('ul > li').length,
      30,
      'project name search retains its bounded summary page',
    );
    await React.act(async () => root.render(React.createElement(View, { query: 'Host' })));
    assert.equal(
      group('project-a').querySelectorAll('ul > li').length,
      30,
      'computer name search does not require matching session titles',
    );
    assert(
      f
        .listCalls()
        .every(
          (request) =>
            request.action === 'execute' &&
            request.command.method === 'sessions-page' &&
            request.command.params.limit === 30,
        ),
    );
    await React.act(async () => root.render(React.createElement(View, { query: 'Needle' })));
    assert.equal(group('project-a').querySelectorAll('ul > li').length, 1);
    assert.match(group('project-a').textContent!, /Needle far session/);
    assert(
      f
        .listCalls()
        .some(
          (request) =>
            request.action === 'execute' &&
            request.command.method === 'sessions-page' &&
            request.command.params.query === 'Needle',
        ),
    );
    await React.act(async () => root.render(React.createElement(View)));
    await React.act(async () => button(group('project-a'), '项目菜单：project-a').click());
    const archive = [
      ...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((entry) => entry.textContent?.includes('查看已归档'));
    assert(archive);
    await React.act(async () => archive.click());
    assert.equal(group('project-a').querySelectorAll('ul > li').length, 5);
    assert.match(group('project-a').textContent!, /Archived 99/);
    assert(
      f
        .listCalls()
        .some(
          (request) =>
            request.action === 'execute' &&
            request.command.method === 'sessions-page' &&
            request.command.params.archived === 'archived',
        ),
    );

    await React.act(async () => button(group('project-a'), '返回最近').click());
    f.rows.find((row) => row.project.localProjectId === 'project-a')!.title = 'Metadata changed';
    const beforeStale = f.listCalls().length;
    await React.act(async () => button(group('project-a'), '加载更多会话').click());
    assert.equal(f.listCalls().length, beforeStale + 1, 'a stale cursor is not silently restarted');
    assert.match(group('project-a').textContent!, /列表已变化/);
    assert.equal(
      group('project-a').querySelectorAll('ul > li').length,
      0,
      'a 409 does not render cached pages as current',
    );
    await React.act(async () => {
      button(group('project-a'), '重新读取').click();
      await refreshing;
    });
    const entered = signal(),
      release = signal();
    f.controls.after = async (request) => {
      if (
        request.action === 'execute' &&
        request.target.localProjectId === 'project-a' &&
        request.command.method === 'sessions-page' &&
        request.command.params.cursor
      ) {
        entered.resolve();
        await release.promise;
      }
    };
    await React.act(async () => {
      button(
        dom.window.document.querySelector('[aria-label="最近会话"]')!,
        '加载更多最近会话',
      ).click();
      await entered.promise;
    });
    await React.act(async () => root.render(React.createElement(View, { query: 'Needle' })));
    await React.act(async () => {
      release.resolve();
      assert.equal(await more, false, 'late global pages cannot advance the new query');
    });
    assert.equal(group('project-a').querySelectorAll('ul > li').length, 1);
    assert.match(group('project-a').textContent!, /Needle far session/);
    assert(
      f.calls.every(
        (request) =>
          request.action === 'catalog' ||
          (request.action === 'execute' &&
            ['sessions-page', 'sessions'].includes(request.command.method)),
      ),
    );
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
