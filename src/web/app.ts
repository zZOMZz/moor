import {
  showShell,
  showNavigation,
  showTarget,
  showRunControls,
  showAuth,
  closeNavigation,
  resizeComposer,
  sendIcon,
} from './ui';
import { Flock, LoroDoc, decode, encode, delta, vv, mirror, putMeta, metas } from '../model';
import { agentSchema, type Mutation, type RuntimeWorkspace } from '../protocol';
import { resolveRunSelection, selectionFromInput, type RunSelection } from '../run-config';
import type { Workspace, ProjectReplica } from '../catalog';
import * as cache from './cache';
import { esc, renderItem, renderFileChanges } from './content';
import {
  filterCatalogSessions,
  catalogSessionList,
  resolveSelection,
  type Device,
  type Selection,
  type SessionSummary,
} from './navigation';
let search = '',
  projectFilter = '',
  restoredSelection = false,
  selectionLoading = 0;
let localOnly = false;
let catalog: Workspace[] = [],
  activeWorkspace: Workspace | undefined,
  replica: ProjectReplica | undefined;
let owner = '',
  devices: Device[] = [],
  selected: Device | undefined,
  workspace: RuntimeWorkspace | undefined,
  sessionId = '',
  doc = new LoroDoc(),
  flock = new Flock(),
  meta: any = null;
let events: WebSocket | null = null,
  connected = false,
  sessionGeneration = 0,
  refreshTimer: ReturnType<typeof setTimeout> | undefined,
  pending: Mutation | undefined,
  sending = false;
let sessionList: SessionSummary[] = [];
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const rendered = new WeakMap<HTMLElement, string>();
function renderInto(selector: string, html: string) {
  const el = $(selector);
  if (rendered.get(el) !== html) {
    el.innerHTML = html;
    rendered.set(el, html);
  }
}
let networkNotice = false;
function error(e: unknown) {
  networkNotice = e instanceof ApiError && (e.status === 0 || (e.status === 409 && !e.rejected));
  const el = document.querySelector('#notice');
  if (el) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('visible');
  }
}
function clearRecoveredNotice() {
  if (!networkNotice || !connected || !selected?.online) return;
  const notice = document.querySelector('#notice');
  if (notice) {
    notice.textContent = '';
    notice.classList.remove('visible');
  }
  networkNotice = false;
}
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public rejected = false,
  ) {
    super(message);
  }
}
async function api(path: string, body?: unknown) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 10000 : 45000),
  }).catch(() => {
    throw new ApiError('中转服务暂不可达，草稿和待确认请求已保留。', 0);
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error, r.status, data.rejected === true);
  return data;
}
function prefix() {
  if (!activeWorkspace || !replica) throw new Error('请先选择项目副本');
  return `/api/workspaces/${activeWorkspace.id}/replicas/${replica.id}`;
}
function query() {
  return `?workspace=${encodeURIComponent(workspace!.id)}`;
}
function key(kind: string) {
  return [owner, selected?.id, workspace?.id, sessionId || 'new', kind].join('/');
}
function run(fn: () => Promise<unknown>) {
  void fn().catch(error);
}
async function boot() {
  try {
    const me = await api('/api/me');
    if (!me.owner) {
      showLogin(me.needsSetup);
      return;
    }
    localOnly = me.localOnly === true;
    owner = me.owner;
    shell();
    connect();
    await cache.write('last-owner', owner).catch(error);
    devices = (await cache.read<Device[]>(owner + '/devices').catch(() => undefined)) ?? [];
    catalog = (await cache.read<Workspace[]>(owner + '/workspaces').catch(() => undefined)) ?? [];
    await loadDevices();
    await restoreSelection();
  } catch {
    owner = (await cache.read<string>('last-owner').catch(() => undefined)) ?? '';
    if (owner) {
      shell();
      devices = (await cache.read<Device[]>(owner + '/devices').catch(() => undefined)) ?? [];
      catalog = (await cache.read<Workspace[]>(owner + '/workspaces').catch(() => undefined)) ?? [];
      catalog = catalog.map((w) => ({
        ...w,
        hosts: w.hosts.map((h) => ({ ...h, online: false })),
        replicas: w.replicas.map((r) => ({ ...r, available: false })),
      }));
      devices = devices.map((d) => ({ ...d, online: false }));
      renderDevices();
      error(new ApiError('当前离线，可阅读本机缓存的历史', 0));
      await restoreSelection().catch(error);
      connect();
    } else showLogin(false);
  }
}
function showLogin(setup: boolean) {
  showAuth({
    setup,
    onSubmit: async (data) => {
      await api(setup ? '/api/setup' : '/api/login', data);
      await boot();
    },
  });
  window.dispatchEvent(new Event('moor:ready'));
}
function shell() {
  showShell({
    onSend: () => run(sendTurn),
    onDraft: (value) => {
      void cache.write(key('draft'), value).catch(error);
    },
    onCancel: cancelTurn,
  });
  window.dispatchEvent(new Event('moor:ready'));
  renderNavigation();
}
function pairComputer() {
  closeNavigation();
  run(async () => {
    const { code } = await api('/api/pair', { workspaceId: activeWorkspace?.id });
    $('#pair-code').textContent = code;
    $('#pair-command').textContent = location.origin;
    $<HTMLDialogElement>('#pair-dialog').showModal();
  });
}
function logout() {
  run(async () => {
    await api('/api/logout', {});
    sessionGeneration++;
    events?.close();
    await cache.clear();
    owner = '';
    selected = undefined;
    workspace = undefined;
    activeWorkspace = undefined;
    catalog = [];
    replica = undefined;
    restoredSelection = false;
    connected = false;
    showLogin(false);
  });
}
function newSession() {
  return run(async () => {
    const copies = activeWorkspace?.replicas.filter((r) => r.projectId === projectFilter) ?? [];
    const currentHost = activeWorkspace?.hosts.find(
      (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
    );
    const copy =
      copies.find((r) => r.hostId === currentHost?.id) ??
      copies.find((r) => r.available) ??
      copies[0];
    const host = activeWorkspace?.hosts.find((h) => h.id === copy?.hostId);
    if (host && host.id !== currentHost?.id)
      await selectDevice(host.deviceId, {
        workspaceId: host.runtimeWorkspaceId,
        projectId: projectFilter,
        search,
        sessionId: '',
      });
    else await openSession('');
  });
}
function cancelTurn() {
  return run(async () => {
    const state = mirror(doc, sessionId),
      turn = state.getState().history.find((t) => t.role === 'assistant' && !t.finished);
    state.dispose();
    if (turn) {
      const result = await api(prefix() + '/cancel' + query(), { sessionId, turnId: turn.id });
      if (result.success === false) throw new Error(result.error ?? '停止未获确认');
    }
  });
}
function connect() {
  events?.close();
  const ws = new WebSocket(new URL('/events', location.href.replace(/^http/, 'ws')));
  events = ws;
  ws.onopen = () => {
    if (events !== ws) return;
    connected = true;
    clearRecoveredNotice();
    renderNavigation();
    renderTarget();
    watch();
    run(async () => {
      await loadDevices();
      await restoreSelection();
      if (activeWorkspace) {
        await loadSessions();
        if (sessionId) await loadSession();
      }
    });
  };
  ws.onclose = () => {
    if (events !== ws || !owner) return;
    connected = false;
    renderNavigation();
    renderTarget();
    updateComposer();
    setTimeout(() => {
      if (events === ws && owner) connect();
    }, 2000);
  };
  ws.onmessage = () => {
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        run(async () => {
          await loadDevices();
          if (activeWorkspace) {
            await loadSessions();
            if (sessionId) await loadSession();
          }
        });
      }, 200);
  };
}
async function loadDevices() {
  const requestedOwner = owner;
  const [fresh, spaces]: [Device[], Workspace[]] = await Promise.all([
    api('/api/devices'),
    api('/api/workspaces'),
  ]);
  if (!owner || owner !== requestedOwner) return;
  devices = fresh.map((d) => ({
    ...d,
    workspaces: d.workspaces.length
      ? d.workspaces
      : (devices.find((old) => old.id === d.id)?.workspaces ?? []),
  }));
  catalog = spaces.map((w) => ({
    ...w,
    replicas: w.replicas.map((r) => ({
      ...r,
      rootPath:
        r.rootPath ??
        catalog.find((old) => old.id === w.id)?.replicas.find((old) => old.id === r.id)?.rootPath,
    })),
  }));
  if (activeWorkspace) activeWorkspace = catalog.find((w) => w.id === activeWorkspace!.id);
  if (replica) replica = activeWorkspace?.replicas.find((r) => r.id === replica!.id);
  await Promise.all([
    cache.write(owner + '/devices', devices),
    cache.write(owner + '/workspaces', catalog),
  ]);
  if (selected) {
    selected = devices.find((d) => d.id === selected!.id);
    workspace = selected?.workspaces.find((w) => w.id === workspace?.id);
    if (
      !selected ||
      !activeWorkspace?.hosts.some(
        (h) => h.deviceId === selected!.id && h.runtimeWorkspaceId === workspace?.id,
      )
    ) {
      selected = undefined;
      workspace = undefined;
      replica = undefined;
      sessionGeneration++;
      sessionId = '';
      doc = new LoroDoc();
      meta = null;
      pending = undefined;
      sessionList = [];
      $('#history').textContent = '执行目标已移出工作区或授权已撤销，请重新选择。';
      renderSessions();
      $<HTMLFormElement>('#composer').hidden = true;
    }
  }
  renderDevices();
  renderNavigation();
  clearRecoveredNotice();
  if (
    selected &&
    !workspace &&
    activeWorkspace?.hosts.some((h) => h.deviceId === selected!.id) &&
    !selectionLoading
  )
    await selectDevice(selected.id);
  updateComposer();
}
function watch() {
  if (events?.readyState !== WebSocket.OPEN) return;
  if (!sessionId || !replica || !selected || !workspace) {
    events.send(JSON.stringify({ type: 'unwatch' }));
    return;
  }
  if (selected && workspace)
    events.send(
      JSON.stringify({
        type: 'watch',
        deviceId: selected.id,
        workspaceId: workspace.id,
        sessionId,
        catalogWorkspaceId: activeWorkspace?.id,
        replicaId: replica?.id,
      }),
    );
}
function renderDevices() {
  renderNavigation();
  renderTarget();
}

function selectReplica(expectedProjectId?: string) {
  const localProjectId =
    expectedProjectId ?? document.querySelector<HTMLSelectElement>('#project')?.value;
  const host = activeWorkspace?.hosts.find(
    (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
  );
  replica = activeWorkspace?.replicas.find(
    (r) => r.hostId === host?.id && r.localProjectId === localProjectId,
  );
  renderTarget();
  void persistSelection().catch(error);
  updateComposer();
}
function renderTarget() {
  const project = activeWorkspace?.projects.find((p) => p.id === replica?.projectId);
  const row = sessionList.find((s) => s.id === sessionId && s.replicaId === replica?.id);
  showTarget({
    project: project?.name || activeWorkspace?.name,
    title: meta?.title || row?.title || (sessionId ? '会话' : '新会话'),
    host: selected?.name,
    path: replica?.rootPath,
    connected,
    online: !!selected?.online,
  });
}

function projectLabel(space: Workspace, projectId: string) {
  const project = space.projects.find((p) => p.id === projectId);
  if (!project) return '项目';
  if (space.projects.filter((p) => p.name === project.name).length < 2) return project.name;
  const names = [
    ...new Set(
      space.replicas
        .filter((r) => r.projectId === projectId)
        .map((r) => space.hosts.find((h) => h.id === r.hostId)?.name)
        .filter(Boolean),
    ),
  ];
  return `${project.name} · ${names.join(' / ') || '未分配副本'}`;
}
function showWorkspaceManager() {
  closeNavigation();
  const dialog = $<HTMLDialogElement>('#workspace-dialog');
  const space = activeWorkspace;
  dialog.innerHTML = `<h2>管理工作区</h2><form id="create-workspace"><label>新工作区名称<input name="name" required maxlength="100"></label><button>创建工作区</button></form>${
    space
      ? `
    <form id="rename-workspace"><label>当前工作区名称<input name="name" value="${esc(space.name)}" required maxlength="100"></label><button>保存名称</button></form>
    <h3>执行电脑</h3><p>更改归属会将这台电脑的本地工作区及其项目副本一起归入目标工作区。会话仍在原电脑执行。</p>
    ${space.hosts.map((h) => `<form data-move-host="${esc(h.id)}"><label>${esc(h.name)}<select name="workspaceId">${catalog.map((w) => `<option value="${esc(w.id)}" ${w.id === space.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label><button>更改归属</button>${localOnly ? '' : `<button type="button" data-revoke="${esc(h.deviceId)}">撤销授权</button>`}</form>`).join('') || '<p>尚未连接电脑。</p>'}
    <h3>项目与本地副本</h3><p>把不同电脑上的副本归入同一项目后，会话列表可以按该项目统一筛选。文件保留在各电脑原目录。</p>
    <form id="create-project"><label>新项目名称<input name="name" required maxlength="200"></label><button>创建项目</button></form>
    ${space.replicas.map((r) => `<form data-assign-replica="${esc(r.id)}"><label>${esc(space.hosts.find((h) => h.id === r.hostId)?.name ?? '')}<small>${esc(r.rootPath ?? '离线副本')}</small><select name="projectId" aria-label="副本所属项目">${space.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === r.projectId ? 'selected' : ''}>${esc(projectLabel(space, p.id))}</option>`).join('')}</select></label><button>保存归组</button></form>`).join('')}
    `
      : ''
  }<p id="manager-notice" role="status"></p><button id="close-workspace-dialog">完成</button>`;
  const submitForm = (
    selector: string,
    action: (data: Record<string, FormDataEntryValue>, form: HTMLFormElement) => Promise<void>,
  ) => {
    dialog.querySelectorAll<HTMLFormElement>(selector).forEach(
      (form) =>
        (form.onsubmit = (event) => {
          event.preventDefault();
          const fields = Object.fromEntries(new FormData(form));
          form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
          void action(fields, form)
            .catch((e) => {
              $('#manager-notice').textContent = e instanceof Error ? e.message : String(e);
            })
            .finally(() =>
              form
                .querySelectorAll<HTMLButtonElement>('button')
                .forEach((b) => (b.disabled = false)),
            );
        }),
    );
  };
  submitForm('#create-workspace', async (data) => {
    const created = await api('/api/workspaces', data);
    await loadDevices();
    await selectWorkspace(created.id);
    showWorkspaceManager();
  });
  const refresh = async () => {
    await loadDevices();
    await loadSessions();
    showWorkspaceManager();
  };
  submitForm('#rename-workspace', async (data) => {
    await api(`/api/workspaces/${space!.id}/rename`, data);
    await refresh();
  });
  submitForm('#create-project', async (data) => {
    await api(`/api/workspaces/${space!.id}/projects`, data);
    await refresh();
  });
  submitForm('[data-assign-replica]', async (data, form) => {
    await api(`/api/workspaces/${space!.id}/replicas/${form.dataset.assignReplica}/assign`, data);
    await refresh();
  });
  submitForm('[data-move-host]', async (data, form) => {
    await api(`/api/workspaces/${space!.id}/hosts/${form.dataset.moveHost}/move`, data);
    await refresh();
  });
  dialog.querySelectorAll<HTMLElement>('[data-revoke]').forEach(
    (button) =>
      (button.onclick = () =>
        run(async () => {
          if (!confirm('撤销这台电脑的远程访问授权？本地执行组件可继续使用。')) return;
          await api(`/api/devices/${button.dataset.revoke}/revoke`, {});
          await refresh();
        })),
  );
  $('#close-workspace-dialog').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
}
async function selectWorkspace(id: string, saved?: Partial<Selection>) {
  const target = catalog.find((w) => w.id === id);
  if (!target) return;
  activeWorkspace = target;
  search = saved?.search ?? '';
  projectFilter = target.projects.some((p) => p.id === saved?.projectId) ? saved!.projectId! : '';
  selected = undefined;
  workspace = undefined;
  replica = undefined;
  sessionId = '';
  pending = undefined;
  sessionGeneration++;
  renderDevices();
  renderNavigation();
  watch();
  const exactHost = target.hosts.find(
    (h) => h.deviceId === saved?.deviceId && h.runtimeWorkspaceId === saved?.workspaceId,
  );
  const host = exactHost ?? target.hosts[0];
  if (host)
    await selectDevice(host.deviceId, {
      ...(exactHost ? saved : {}),
      workspaceId: host.runtimeWorkspaceId,
      search,
      projectId: projectFilter,
    });
  else {
    sessionList = [];
    $('#composer').hidden = true;
    renderTarget();
    $('#history').textContent = '添加电脑后，可在这个工作区开始会话。';
    renderSessions();
    await persistSelection();
  }
}
async function persistSelection() {
  if (!activeWorkspace) return;
  const state: Selection = {
    deviceId: selected?.id ?? '',
    workspaceId: workspace?.id ?? '',
    sessionId,
    search,
    projectId: projectFilter,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica?.id,
  };
  await Promise.all([
    cache.write(owner + '/view', state),
    cache.write(owner + '/' + (selected?.id ?? activeWorkspace.id) + '/view', state),
  ]);
}
async function restoreSelection() {
  if (restoredSelection) return;
  restoredSelection = true;
  const generation = sessionGeneration;
  const saved = await cache.read<Selection>(owner + '/view');
  if (generation !== sessionGeneration) return;
  const space =
    catalog.find((w) => w.id === saved?.catalogWorkspaceId) ??
    catalog.find((w) =>
      w.hosts.some(
        (h) => h.deviceId === saved?.deviceId && h.runtimeWorkspaceId === saved?.workspaceId,
      ),
    ) ??
    catalog[0];
  if (space) await selectWorkspace(space.id, saved);
}
async function selectDevice(id: string, explicit?: Partial<Selection>) {
  restoredSelection = true;
  const generation = ++sessionGeneration;
  selectionLoading = generation;
  try {
    selected = devices.find((d) => d.id === id);
    workspace = undefined;
    replica = undefined;
    sessionId = '';
    watch();
    sessionList = [];
    meta = null;
    pending = undefined;
    doc = new LoroDoc();
    $('#composer').hidden = true;
    renderDevices();
    renderSessions();
    const saved = explicit ?? (await cache.read<Selection>(owner + '/' + id + '/view'));
    if (generation !== sessionGeneration) return;
    const binding =
      activeWorkspace?.hosts.find(
        (h) =>
          h.deviceId === id && (!saved?.workspaceId || h.runtimeWorkspaceId === saved.workspaceId),
      ) ?? activeWorkspace?.hosts.find((h) => h.deviceId === id);
    const target =
      binding &&
      resolveSelection(devices, {
        ...saved,
        deviceId: id,
        workspaceId: binding.runtimeWorkspaceId,
      });
    if (!target || target.workspace.id !== binding?.runtimeWorkspaceId) {
      renderNavigation();
      renderTarget();
      $('#history').textContent = '等待电脑上的执行组件启动并同步工作区…';
      await loadSessions();
      return;
    }
    selected = target.device;
    workspace = target.workspace;
    search = saved?.search ?? '';
    projectFilter = activeWorkspace?.projects.some((p) => p.id === saved?.projectId)
      ? saved!.projectId!
      : '';
    renderDevices();
    renderNavigation();
    await loadSessions();
    if (generation !== sessionGeneration) return;
    await openSession(target.sessionId, saved?.replicaId);
  } finally {
    if (selectionLoading === generation) selectionLoading = 0;
  }
}
function renderNavigation() {
  showNavigation({
    catalog,
    space: activeWorkspace,
    projectLabels: Object.fromEntries(
      activeWorkspace?.projects.map((p) => [p.id, projectLabel(activeWorkspace!, p.id)]) ?? [],
    ),
    list: filterCatalogSessions(sessionList, activeWorkspace, search, projectFilter),
    projectFilter,
    search,
    selectedSession: sessionId,
    selectedReplica: replica?.id,
    deviceId: selected?.id,
    runtimeWorkspaceId: workspace?.id,
    connected,
    localOnly,
    canCreate: !!workspace,
    onWorkspace: (id) => run(() => selectWorkspace(id)),
    onHost: (id) =>
      run(async () => {
        const host = activeWorkspace?.hosts.find((h) => h.id === id);
        if (host)
          await selectDevice(host.deviceId, {
            workspaceId: host.runtimeWorkspaceId,
            sessionId: '',
            search,
            projectId: projectFilter,
          });
      }),
    onSearch: (value) => {
      search = value;
      renderNavigation();
      run(persistSelection);
    },
    onProject: (value) => {
      projectFilter = value;
      renderNavigation();
      run(persistSelection);
    },
    onSession: (id, copy) => run(() => openSession(id, copy)),
    onNew: newSession,
    onManage: showWorkspaceManager,
    onPair: pairComputer,
    onLogout: logout,
  });
}

async function loadSessions() {
  if (!activeWorkspace) return;
  const space = activeWorkspace,
    generation = sessionGeneration,
    requestedOwner = owner;
  // Bound concurrency; every host returns its own index, which stays in browser cache.
  const rows: SessionSummary[][] = [];
  for (let i = 0; i < space.hosts.length; i += 4) {
    rows.push(
      ...(await Promise.all(
        space.hosts.slice(i, i + 4).map(async (host) => {
          const listKey = [requestedOwner, host.deviceId, host.runtimeWorkspaceId, 'list'].join(
            '/',
          );
          let list: SessionSummary[];
          try {
            if (!host.online) throw new Error('offline');
            list = await api(`/api/workspaces/${space.id}/hosts/${host.id}/sessions`);
            await cache.write(listKey, list);
          } catch {
            list = (await cache.read<SessionSummary[]>(listKey)) ?? [];
          }
          return catalogSessionList(list, space, host.id);
        }),
      )),
    );
  }
  if (activeWorkspace !== space || generation !== sessionGeneration || owner !== requestedOwner)
    return;
  sessionList = rows.flat();
  renderSessions();
}
function renderSessions() {
  renderNavigation();
  renderTarget();
}

async function openSession(id: string, replicaId?: string) {
  const row = sessionList.find(
    (s) =>
      s.id === id &&
      (replicaId
        ? s.replicaId === replicaId
        : activeWorkspace?.replicas.find((r) => r.id === s.replicaId)?.hostId ===
          activeWorkspace?.hosts.find(
            (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
          )?.id),
  );
  const target = activeWorkspace?.replicas.find(
    (r) => r.id === (replicaId || row?.replicaId || (id ? replica?.id : undefined)),
  );
  if (id && !target) throw new Error('该会话的项目副本不可用，请从会话列表重新选择。');
  if (id && target) {
    const host = activeWorkspace!.hosts.find((h) => h.id === target.hostId)!;
    selected = devices.find((d) => d.id === host.deviceId);
    workspace = selected?.workspaces.find((w) => w.id === host.runtimeWorkspaceId);
    replica = target;
  }
  if (!workspace) return;
  if (!id) replica = undefined;
  renderDevices();
  rendered.delete($('#history'));
  const generation = ++sessionGeneration;
  runOptionsReady = false;
  runOptionsGeneration++;
  sessionId = id;
  closeNavigation();
  void persistSelection().catch(error);
  doc = new LoroDoc();
  flock = new Flock();
  meta = null;
  const restored = await cache.read<Mutation>(key('pending'));
  if (generation !== sessionGeneration) return;
  pending = restored;
  renderSessions();
  renderTarget();
  $<HTMLFormElement>('#composer').hidden = false;
  const draft = await cache.read<string>(key('draft'));
  if (generation !== sessionGeneration) return;
  $<HTMLTextAreaElement>('#prompt').value = draft ?? '';
  resizeComposer();
  $('#new-options').innerHTML = id
    ? ''
    : `<label>项目<select id="project">${workspace.projects.map((p) => `<option value="${esc(p.id)}">${esc(activeWorkspace?.projects.find((logical) => logical.id === activeWorkspace?.replicas.find((r) => r.localProjectId === p.id && activeWorkspace?.hosts.some((h) => h.id === r.hostId && h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id))?.projectId)?.name ?? p.name)}</option>`).join('')}</select></label><label>Agent<select id="agent">${workspace.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label>`;
  let pendingProject: string | undefined;
  if (!id) {
    const options = await cache.read<{ project: string; agent: string }>(key('options'));
    if (generation !== sessionGeneration) return;
    const filtered = activeWorkspace?.replicas.find(
      (r) =>
        r.projectId === projectFilter &&
        activeWorkspace?.hosts.some(
          (h) =>
            h.id === r.hostId &&
            h.deviceId === selected?.id &&
            h.runtimeWorkspaceId === workspace?.id,
        ),
    );
    const pendingMeta = new Flock();
    if (pending?.metaBundle) pendingMeta.importJson(pending.metaBundle as never);
    const pendingAgent = pending
      ? metas(pendingMeta)['session-' + pending.sessionId]?.agentConfigId
      : undefined;
    pendingProject = pending
      ? (metas(pendingMeta)['session-' + pending.sessionId]?.project as any)?.localProjectId
      : undefined;
    const project = pendingProject || filtered?.localProjectId || options?.project;
    if (workspace.projects.some((p) => p.id === project))
      $<HTMLSelectElement>('#project').value = project!;
    const agentId = pendingAgent || options?.agent;
    if (workspace.agents.some((a) => a.id === agentId))
      $<HTMLSelectElement>('#agent').value = String(agentId);
    for (const selector of ['#project', '#agent'])
      $(selector).onchange = () => {
        selectReplica();
        if (selector === '#agent') void restoreRunOptions().catch(error);
        void cache
          .write(key('options'), {
            project: $<HTMLSelectElement>('#project').value,
            agent: $<HTMLSelectElement>('#agent').value,
          })
          .catch(error);
      };
  }
  if (!id) selectReplica(pendingProject);
  watch();
  if (id) {
    const saved = await cache.read<any>(key('session'));
    if (generation !== sessionGeneration) return;
    if (saved) {
      doc.import(decode(saved.snapshot));
      flock.importJson(saved.metaBundle);
      meta = saved.meta;
      renderHistory();
    } else $('#history').textContent = '正在读取会话…';
    try {
      await loadSession();
    } catch (e) {
      if (generation !== sessionGeneration) return;
      if (!saved) $('#history').textContent = '执行电脑不可达，当前设备尚未缓存这段会话。';
      error(e);
    }
  } else
    $('#history').innerHTML =
      '<div class="welcome compact"><span class="eyebrow">NEW SESSION</span><h1>开始一段新的工作。</h1><p>选择这台电脑上的项目和 Agent，然后发送第一条指令。</p></div>';
  if (generation !== sessionGeneration) return;
  await restoreRunOptions();
  updateComposer();
}
async function loadSession() {
  const generation = sessionGeneration,
    id = sessionId;
  if (!id) return;
  const data = await api(
    prefix() + '/sessions/' + id + query() + '&version=' + encodeURIComponent(vv(doc)),
  );
  if (generation !== sessionGeneration) return;
  if (data.update) doc.import(decode(data.update));
  flock.importJson(data.metaBundle);
  meta = data.meta;
  renderTarget();
  await cache.write(key('session'), {
    snapshot: encode(doc.export({ mode: 'snapshot' })),
    metaBundle: flock.exportJson(),
    meta,
  });
  if (generation !== sessionGeneration) return;
  if (!data.synced) $('#history').textContent = '执行电脑不可达；本机尚未缓存这段历史。';
  else renderHistory();
  updateComposer();
}
function renderHistory() {
  const view = mirror(doc, sessionId),
    state = view.getState();
  const container = $('#history'),
    atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const html =
    state.history
      .map(
        (turn) =>
          `<article class="turn ${turn.role}"><div class="turn-label">${turn.role === 'user' ? '你' : esc(meta?.agentType ?? 'Agent')} <time>${new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${(
            turn.items ?? []
          )
            .map((item: any, index: number) =>
              renderItem(item, !!turn.finished, `${turn.id}/${index}`),
            )
            .join(
              '',
            )}${renderFileChanges(turn.fileDiff, turn.id + '/files')}${turn.role === 'assistant' && !turn.finished ? '<span class="working">Agent 正在处理</span>' : ''}</article>`,
      )
      .join('') || '<p class="empty">会话已建立，等待第一条消息。</p>';
  const expanded = new Map(
    Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-detail]')).map((el) => [
      el.dataset.detail,
      el.open,
    ]),
  );
  renderInto('#history', html);
  container.querySelectorAll<HTMLDetailsElement>('details[data-detail]').forEach((el) => {
    if (expanded.has(el.dataset.detail)) el.open = expanded.get(el.dataset.detail)!;
  });
  container.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.onclick = () =>
      run(async () => {
        const text = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
      });
  });
  view.dispose();
  document.querySelectorAll<HTMLElement>('[data-permission]').forEach((el) => {
    el.toggleAttribute('disabled', sending || !!pending || !connected || !selected?.online);
    el.onclick = () => run(() => respondPermission(el.dataset.permission!, el.dataset.option!));
  });
  if (atBottom) container.scrollTop = container.scrollHeight;
}
let runSelection: RunSelection = {},
  runOptionsLoading = false,
  runOptionsReady = false;
let runOptionsGeneration = 0;
let runSelectionTouched = false;
const capabilityAttempts = new Set<string>();
function currentAgent() {
  return workspace?.agents.find(
    (a) =>
      a.id === (meta?.agentConfigId ?? document.querySelector<HTMLSelectElement>('#agent')?.value),
  );
}
function runOptionsKey() {
  return key('run-options') + '/' + currentAgent()?.id;
}
function currentRunInput() {
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  if (pending?.kind === 'turn') candidate.import(decode(pending.update));
  const view = mirror(candidate, pending?.sessionId || sessionId || 'new');
  const state = view.getState();
  const latest = state.history.findLast((t) => t.role === 'user');
  const input = latest?.inputConfig as
    | { modelId?: string; modeId?: string; configOptionValues?: unknown }
    | undefined;
  const result = { base: latest?.id ?? '', input: structuredClone(input) };
  view.dispose();
  return result;
}
async function restoreRunOptions() {
  const generation = ++runOptionsGeneration,
    session = sessionGeneration;
  runOptionsReady = false;
  runOptionsLoading = false;
  updateComposer();
  const current = currentRunInput();
  const saved = await cache.read<{ base: string; selection: RunSelection }>(runOptionsKey());
  if (generation !== runOptionsGeneration || session !== sessionGeneration) return;
  runSelectionTouched = !pending && saved?.base === current.base;
  runSelection =
    !pending && saved?.base === current.base
      ? saved.selection
      : selectionFromInput(current.input, currentAgent()?.runConfig);
  runOptionsReady = true;
  updateComposer();
  const attempt = [owner, selected?.id, workspace?.id, currentAgent()?.id].join('/');
  if (
    !currentAgent()?.runConfig &&
    currentAgent() &&
    connected &&
    selected?.online &&
    replica?.available &&
    !pending &&
    !capabilityAttempts.has(attempt)
  ) {
    capabilityAttempts.add(attempt);
    void refreshRunOptions().catch(error);
  }
}
async function refreshRunOptions() {
  const agent = currentAgent();
  if (!agent || runOptionsLoading || pending || sending) return;
  const generation = runOptionsGeneration,
    session = sessionGeneration;
  runOptionsLoading = true;
  updateComposer();
  try {
    const updated = agentSchema.parse(
      await api(prefix() + '/agent-options', { agentId: agent.id }),
    );
    if (
      generation !== runOptionsGeneration ||
      session !== sessionGeneration ||
      currentAgent()?.id !== agent.id
    )
      return;
    Object.assign(currentAgent()!, updated);
    // Recover an effort field from the saved native turn when capabilities were initially unavailable.
    if (!runSelectionTouched && !pending && !runSelection.reasoningEffort) {
      const inherited = selectionFromInput(currentRunInput().input, updated.runConfig);
      if (inherited.modelId === runSelection.modelId)
        runSelection.reasoningEffort = inherited.reasoningEffort;
    }
  } finally {
    if (generation === runOptionsGeneration && session === sessionGeneration) {
      runOptionsLoading = false;
      updateComposer();
    }
  }
}
function renderRunOptions() {
  const capabilities = currentAgent()?.runConfig;
  let validation = '';
  try {
    resolveRunSelection(runSelection, capabilities);
  } catch (e) {
    validation = (e as Error).message;
  }
  showRunControls({
    capabilities,
    selection: runSelection,
    agentType: currentAgent()?.agentType,
    disabled: sending || !!pending || runOptionsLoading || !runOptionsReady,
    loading: runOptionsLoading,
    canRefresh: connected && !!selected?.online && !!replica?.available,
    validation,
    existing: !!sessionId,
    onChange: (property, value) => {
      runSelectionTouched = true;
      runSelection = { ...runSelection, [property]: value || undefined };
      if (
        property === 'modelId' &&
        !capabilities?.models
          .find((m) => m.id === runSelection.modelId)
          ?.efforts.includes(runSelection.reasoningEffort ?? '')
      )
        runSelection.reasoningEffort = undefined;
      void cache
        .write(runOptionsKey(), { base: currentRunInput().base, selection: { ...runSelection } })
        .catch(error);
      updateComposer();
    },
    onRefresh: () => run(refreshRunOptions),
  });
  return !!validation;
}

function updateComposer() {
  const invalidRunOptions = renderRunOptions();
  document
    .querySelectorAll<HTMLButtonElement>('[data-permission]')
    .forEach((b) => (b.disabled = sending || !!pending || !connected || !selected?.online));
  const create = document.querySelector<HTMLButtonElement>('#new');
  if (create) create.disabled = !workspace;
  for (const selector of ['#project', '#agent']) {
    const field = document.querySelector<HTMLSelectElement>(selector);
    if (field) field.disabled = sending || !!pending;
  }
  const send = document.querySelector<HTMLButtonElement>('#send');
  if (!send) return;
  send.disabled =
    sending ||
    !connected ||
    !selected?.online ||
    !replica?.available ||
    (!pending &&
      (!runOptionsReady ||
        runOptionsLoading ||
        invalidRunOptions ||
        !currentAgent() ||
        (!sessionId && !workspace?.projects.length)));
  sendIcon(sending ? 'sending' : pending ? 'pending' : 'ready');
  send.setAttribute('aria-label', sending ? '提交中' : pending ? '重试确认' : '发送指令');
  send.classList.toggle('pending', !!pending);
  $<HTMLTextAreaElement>('#prompt').readOnly = sending || !!pending;
  const state = document.querySelector('#draft-state');
  if (state)
    state.textContent = pending
      ? '提交结果待确认，重试会使用同一编号'
      : !connected || !selected?.online
        ? '执行电脑离线 · 输入保留为草稿'
        : '';
  if (state) state.toggleAttribute('hidden', !state.textContent);
  let active = false;
  if (sessionId) {
    const v = mirror(doc, sessionId);
    active = v.getState().history.some((t) => t.role === 'assistant' && !t.finished);
    v.dispose();
  }
  if (active && !pending) send.disabled = true;
  if (active && state && !pending && selected?.online && connected) {
    state.textContent = 'Agent 正在处理 · 下一条指令保留为草稿';
    state.removeAttribute('hidden');
  }
  $<HTMLButtonElement>('#cancel').hidden = !active;
  $<HTMLButtonElement>('#cancel').disabled = !connected || !selected?.online;
}
async function submit(m: Mutation) {
  if (sending) return;
  const generation = sessionGeneration,
    pendingKey = key('pending'),
    draftKey = key('draft'),
    endpoint = prefix() + '/mutations' + query();
  pending = m;
  sending = true;
  updateComposer();
  let durable = false;
  try {
    await cache.write(pendingKey, m);
    durable = true;
    await api(endpoint, m);
    await cache.write(pendingKey, undefined);
    if (m.kind === 'turn') await cache.write(draftKey, '');
    if (generation !== sessionGeneration) return;
    pending = undefined;
    if (m.kind === 'turn') $<HTMLTextAreaElement>('#prompt').value = '';
    await openSession(m.sessionId);
    await loadSessions();
  } catch (e) {
    // Only an explicit rejection from the host proves this operation was never staged.
    // Relay offline/timeout errors cannot invalidate the original operation id.
    if (!durable || (e instanceof ApiError && e.rejected)) {
      await cache.write(pendingKey, undefined);
      if (generation === sessionGeneration) pending = undefined;
    }
    throw e;
  } finally {
    sending = false;
    updateComposer();
  }
}
async function sendTurn() {
  if (pending) {
    await submit(pending);
    return;
  }
  if (!workspace || !selected?.online || !connected) throw new Error('执行电脑离线，草稿已保留');
  const prompt = $<HTMLTextAreaElement>('#prompt').value.trim();
  if (!prompt) return;
  const generation = sessionGeneration;
  if (!sessionId)
    await cache.write(key('options'), {
      project: $<HTMLSelectElement>('#project').value,
      agent: $<HTMLSelectElement>('#agent').value,
    });
  if (generation !== sessionGeneration) return;
  const id = sessionId || crypto.randomUUID(),
    agent = workspace.agents.find(
      (a) => a.id === (meta?.agentConfigId ?? $<HTMLSelectElement>('#agent')?.value),
    );
  if (!agent) throw new Error('这台电脑还没有可用的 Agent 配置');
  if (!runOptionsReady || runOptionsLoading) throw new Error('正在读取运行设置，请稍后发送');
  const selectedConfig = resolveRunSelection(runSelection, agent.runConfig);
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  const localFlock = Flock.fromJson(
    flock.exportJson(),
    crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  );
  const before = vv(candidate),
    metaVersion = localFlock.version(),
    view = mirror(candidate, id),
    turnId = crypto.randomUUID(),
    now = new Date().toISOString();
  const inputConfig = {
    ...selectedConfig,
    prompt,
    cliType: agent.cliType,
    agentType: agent.agentType,
    mcpServerIds: [],
    taskToolsEnabled: false,
  };
  view.setState((s: any) => {
    s.history.push({
      id: turnId,
      role: 'user',
      userId: workspace!.userId,
      timestamp: now,
      status: 'pending',
      finished: true,
      inputConfig,
      items: [{ type: 'text', text: prompt }],
      fileDiff: null,
    });
  });
  view.dispose();
  candidate.commit();
  const fields = meta
    ? { latestUserMsgId: turnId, lastMessageAt: Date.now() }
    : {
        id,
        machineId: workspace.machineId,
        userId: workspace.userId,
        createdAt: now,
        title: prompt.slice(0, 60),
        titleSource: 'user',
        cliType: agent.cliType,
        agentType: agent.agentType,
        agentConfigId: agent.id,
        status: { type: 'idle' },
        isArchived: false,
        project: { kind: 'local', localProjectId: $<HTMLSelectElement>('#project').value },
        latestUserMsgId: turnId,
        lastMessageAt: Date.now(),
      };
  putMeta(localFlock, 'session-' + id, fields);
  await submit({
    operationId: crypto.randomUUID(),
    workspaceId: workspace.id,
    sessionId: id,
    kind: 'turn',
    expectedTurnId: meta?.latestUserMsgId ?? null,
    update: delta(candidate, before),
    metaBundle: localFlock.exportJson(metaVersion),
  });
}
async function respondPermission(requestId: string, optionId: string) {
  if (sending || pending) throw new Error('请先确认上一次提交结果');
  if (!connected || !selected?.online) throw new Error('执行电脑离线，无法提交审批');
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  const before = vv(candidate),
    view = mirror(candidate, sessionId);
  view.setState((s: any) => {
    for (const t of s.history)
      for (const item of t.items ?? [])
        if (item.permissionRequest?.requestId === requestId)
          item.permissionRequest.outcome = optionId
            ? { outcome: 'selected', optionId }
            : { outcome: 'cancelled' };
  });
  view.dispose();
  candidate.commit();
  await submit({
    operationId: crypto.randomUUID(),
    workspaceId: workspace!.id,
    sessionId,
    kind: 'permission',
    expectedTurnId: meta.latestUserMsgId ?? null,
    requestId,
    update: delta(candidate, before),
  });
}
if (
  'serviceWorker' in navigator &&
  !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
)
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && owner) {
    if (!events || events.readyState > WebSocket.OPEN) connect();
    else
      run(async () => {
        await loadDevices();
        if (sessionId) await loadSession();
      });
  }
});
window.addEventListener('online', () => {
  if (owner) connect();
});
void boot();
