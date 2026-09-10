import { Flock, LoroDoc, decode, encode, delta, vv, mirror, putMeta } from '../model';
import type { Mutation, Workspace } from '../protocol';
import * as cache from './cache';
const root = document.querySelector<HTMLElement>('#app')!;
import { esc, renderItem, renderFileChanges } from './content';
import {
  filterSessions,
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
let owner = '',
  devices: Device[] = [],
  selected: Device | undefined,
  workspace: Workspace | undefined,
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
  networkNotice = e instanceof ApiError && e.status === 0;
  const el = document.querySelector('#notice');
  if (el) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('visible');
  }
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
  }).catch(() => {
    throw new ApiError('中转服务暂不可达，草稿和待确认请求已保留。', 0);
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error, r.status, data.rejected === true);
  return data;
}
function prefix() {
  return `/api/devices/${selected!.id}`;
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
    await cache.write('last-owner', owner);
    devices = (await cache.read<Device[]>(owner + '/devices')) ?? [];
    shell();
    connect();
    await loadDevices();
    await restoreSelection();
  } catch {
    owner = (await cache.read<string>('last-owner')) ?? '';
    if (owner) {
      shell();
      devices = (await cache.read<Device[]>(owner + '/devices')) ?? [];
      devices = devices.map((d) => ({ ...d, online: false }));
      renderDevices();
      error(new Error('当前离线，可阅读本机缓存的历史'));
      await restoreSelection();
      connect();
    } else showLogin(false);
  }
}
function showLogin(setup: boolean) {
  root.innerHTML = `<div class="auth"><div class="brand"><img class="mark" src="/icon-192.png" alt="" /> Moor <span class="subtle">泊点</span></div><h1>${setup ? '你的电脑，随处可达。' : '继续你的工作。'}</h1><p>项目留在电脑上，从手机或另一台电脑继续对话。</p><form id="login"><label>邮箱<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 12 : 1}" required></label>${setup ? '<label>初始化口令<input name="setupToken" autocomplete="off" required></label><small>口令位于服务端首次启动时显示的文件中。</small>' : ''}<button class="primary">${setup ? '创建个人账号' : '登录'}</button></form><p id="notice" role="alert"></p></div>`;
  $('#login').onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const data = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
      await api(setup ? '/api/setup' : '/api/login', data);
      await boot();
    });
  };
}
function shell() {
  root.innerHTML = `<header><button id="nav-toggle" class="quiet" aria-label="选择电脑和会话" aria-controls="navigation" aria-expanded="false">☰</button><a class="brand" href="/"><img class="mark" src="/icon-192.png" alt="" /> Moor <span class="subtle">泊点</span></a><div class="header-actions"><span id="connection" class="subtle">正在连接</span><button id="pair">添加电脑</button><button id="logout" class="quiet">退出</button></div></header><button id="nav-shade" hidden aria-label="关闭会话列表"></button><div class="layout"><aside id="navigation"><div class="section-label">我的电脑</div><div id="devices"></div><div class="section-label">会话 <button id="new" class="quiet">＋ 新建</button></div><div id="navigation-controls"></div><div id="session-count" class="subtle"></div><div id="sessions"></div></aside><main><div id="target"></div><div id="notice" role="alert"></div><div id="history"><div class="welcome"><span class="eyebrow">PERSONAL WORKSPACE</span><h1>在任意设备上，<br>接着做下去。</h1><p>选择一台已连接的电脑，打开它的项目与会话。</p><div class="hint">代码和 Agent 始终在你选择的电脑运行。</div></div></div><form id="composer" hidden><div id="new-options"></div><label class="sr-only" for="prompt">发送给 Agent 的指令</label><textarea id="prompt" placeholder="描述接下来要做的事…" rows="3"></textarea><div class="compose-footer"><span id="draft-state">输入保存在当前设备</span><div><button type="button" id="cancel" hidden>停止</button><button class="primary" id="send">发送 ↑</button></div></div></form></main></div><dialog id="pair-dialog"><h2>连接一台电脑</h2><p>在 Mac 上打开 Moor 的连接设置，填写服务地址和下面的配对码。</p><code id="pair-code"></code><p>配对码有效期 5 分钟，仅可使用一次。</p><pre id="pair-command"></pre><button id="close-dialog">完成</button></dialog>`;
  const toggleNav = (open: boolean) => {
    root.toggleAttribute('data-nav-open', open);
    $('#nav-toggle').setAttribute('aria-expanded', String(open));
    $('#nav-shade').hidden = !open;
  };
  $('#nav-toggle').onclick = () => toggleNav(!root.hasAttribute('data-nav-open'));
  $('#nav-shade').onclick = () => toggleNav(false);
  document.onkeydown = (e) => {
    if (e.key === 'Escape') toggleNav(false);
  };
  if (localOnly) {
    $('#pair').hidden = true;
    $('#logout').hidden = true;
  }
  $('#pair').onclick = () =>
    run(async () => {
      const { code } = await api('/api/pair', {});
      $('#pair-code').textContent = code;
      $('#pair-command').textContent = location.origin;
      $<HTMLDialogElement>('#pair-dialog').showModal();
    });
  $('#close-dialog').onclick = () => $<HTMLDialogElement>('#pair-dialog').close();
  $('#logout').onclick = () =>
    run(async () => {
      await api('/api/logout', {});
      sessionGeneration++;
      events?.close();
      await cache.clear();
      owner = '';
      selected = undefined;
      workspace = undefined;
      restoredSelection = false;
      connected = false;
      showLogin(false);
    });
  $('#new').onclick = () => run(() => openSession(''));
  $<HTMLFormElement>('#composer').onsubmit = (e) => {
    e.preventDefault();
    run(sendTurn);
  };
  $<HTMLTextAreaElement>('#prompt').oninput = () => {
    void cache.write(key('draft'), $<HTMLTextAreaElement>('#prompt').value).catch(error);
  };
  $('#cancel').onclick = () =>
    run(async () => {
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
    if (networkNotice) {
      const notice = document.querySelector('#notice');
      if (notice) {
        notice.textContent = '';
        notice.classList.remove('visible');
      }
      networkNotice = false;
    }
    $('#connection').textContent = '已连接';
    watch();
    run(async () => {
      await loadDevices();
      await restoreSelection();
      if (selected && workspace) {
        await loadSessions();
        if (sessionId) await loadSession();
      }
    });
  };
  ws.onclose = () => {
    if (events !== ws || !owner) return;
    connected = false;
    const el = document.querySelector('#connection');
    if (el) el.textContent = '连接中断 · 可读缓存';
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
          if (selected && workspace) {
            await loadSessions();
            if (sessionId) await loadSession();
          }
        });
      }, 200);
  };
}
async function loadDevices() {
  const requestedOwner = owner;
  const fresh: Device[] = await api('/api/devices');
  if (!owner || owner !== requestedOwner) return;
  devices = fresh.map((d) => ({
    ...d,
    workspaces: d.workspaces.length
      ? d.workspaces
      : (devices.find((old) => old.id === d.id)?.workspaces ?? []),
  }));
  await cache.write(owner + '/devices', devices);
  if (selected) {
    selected = devices.find((d) => d.id === selected!.id);
    workspace = selected?.workspaces.find((w) => w.id === workspace?.id);
    if (!selected) {
      sessionGeneration++;
      sessionId = '';
      doc = new LoroDoc();
      meta = null;
      pending = undefined;
      sessionList = [];
      $('#history').textContent = '设备授权已撤销';
      renderSessions();
      $<HTMLFormElement>('#composer').hidden = true;
    }
  }
  renderDevices();
  renderNavigation();
  if (selected && !workspace && selected.workspaces.length && !selectionLoading)
    await selectDevice(selected.id);
  updateComposer();
}
function watch() {
  if (events?.readyState === WebSocket.OPEN && selected && workspace)
    events.send(
      JSON.stringify({
        type: 'watch',
        deviceId: selected.id,
        workspaceId: workspace.id,
        sessionId,
      }),
    );
}
function renderDevices() {
  renderInto(
    '#devices',
    devices.length
      ? devices
          .map(
            (d) =>
              `<div class="device-group"><button class="device ${selected?.id === d.id ? 'selected' : ''}" data-device="${esc(d.id)}"><span class="computer">▣</span><span><strong>${esc(d.name)}</strong><small><i class="dot ${d.online ? 'online' : ''}"></i>${d.online ? '在线' : '离线 · 仅本机缓存'}</small></span></button>${localOnly ? '' : `<button class="revoke quiet" data-revoke="${esc(d.id)}" aria-label="撤销 ${esc(d.name)} 的授权">移除</button>`}</div>`,
          )
          .join('')
      : '<p class="empty">还没有连接电脑。<br>点击“添加电脑”开始。</p>',
  );
  document
    .querySelectorAll<HTMLElement>('[data-device]')
    .forEach((el) => (el.onclick = () => run(() => selectDevice(el.dataset.device!))));
  document.querySelectorAll<HTMLElement>('[data-revoke]').forEach(
    (el) =>
      (el.onclick = () =>
        run(async () => {
          if (!confirm('撤销这台电脑的远程访问授权？本地 Lody 可继续使用。')) return;
          await api('/api/devices/' + el.dataset.revoke + '/revoke', {});
          await loadDevices();
        })),
  );
}
async function persistSelection() {
  if (!selected || !workspace) return;
  const state: Selection = {
    deviceId: selected.id,
    workspaceId: workspace.id,
    sessionId,
    search,
    projectId: projectFilter,
  };
  await Promise.all([
    cache.write(owner + '/view', state),
    cache.write(owner + '/' + selected.id + '/view', state),
  ]);
}
async function restoreSelection() {
  if (restoredSelection) return;
  restoredSelection = true;
  const generation = sessionGeneration;
  const saved = await cache.read<Selection>(owner + '/view');
  if (generation !== sessionGeneration) return;
  const target = resolveSelection(devices, saved);
  if (target) await selectDevice(target.device.id, { ...saved!, workspaceId: target.workspace.id });
  else if (devices.length === 1) await selectDevice(devices[0].id);
}
async function selectDevice(id: string, explicit?: Partial<Selection>) {
  restoredSelection = true;
  const generation = ++sessionGeneration;
  selectionLoading = generation;
  try {
    selected = devices.find((d) => d.id === id);
    workspace = undefined;
    sessionId = '';
    sessionList = [];
    meta = null;
    pending = undefined;
    doc = new LoroDoc();
    $('#composer').hidden = true;
    renderDevices();
    renderSessions();
    const saved = explicit ?? (await cache.read<Selection>(owner + '/' + id + '/view'));
    if (generation !== sessionGeneration) return;
    const target = resolveSelection(devices, { ...saved, deviceId: id });
    if (!target) {
      renderNavigation();
      $('#target').textContent = '';
      $('#history').textContent = '等待电脑上的执行组件启动并同步工作区…';
      return;
    }
    selected = target.device;
    workspace = target.workspace;
    search = target.search;
    projectFilter = target.projectId;
    renderNavigation();
    await loadSessions();
    if (generation !== sessionGeneration) return;
    await openSession(target.sessionId);
  } finally {
    if (selectionLoading === generation) selectionLoading = 0;
  }
}
function renderNavigation() {
  const el = document.querySelector('#navigation-controls');
  if (!el) return;
  if (!selected || !workspace) {
    renderInto('#navigation-controls', '');
    return;
  }
  renderInto(
    '#navigation-controls',
    `<label>工作区<select id="workspace-switch" aria-label="工作区">${selected.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === workspace?.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label><label>项目<select id="project-filter" aria-label="筛选项目"><option value="">全部项目</option>${workspace.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><label class="sr-only" for="session-search">搜索会话或项目</label><input id="session-search" type="search" placeholder="搜索会话或项目…" autocomplete="off">`,
  );
  if ($<HTMLInputElement>('#session-search').value !== search)
    $<HTMLInputElement>('#session-search').value = search;
  $('#session-search').oninput = () => {
    search = $<HTMLInputElement>('#session-search').value;
    renderSessions();
    run(persistSelection);
  };
  $('#project-filter').onchange = () => {
    projectFilter = $<HTMLSelectElement>('#project-filter').value;
    renderSessions();
    run(persistSelection);
  };
  $('#workspace-switch').onchange = () =>
    run(() =>
      selectDevice(selected!.id, {
        workspaceId: $<HTMLSelectElement>('#workspace-switch').value,
        sessionId: '',
        search: '',
        projectId: '',
      }),
    );
}
async function loadSessions() {
  if (!workspace || !selected) return;
  const deviceId = selected.id,
    workspaceId = workspace.id,
    listKey = [owner, deviceId, workspaceId, 'list'].join('/'),
    endpoint = prefix() + '/sessions' + query();
  let list: any[];
  try {
    list = await api(endpoint);
    await cache.write(listKey, list);
  } catch {
    list = (await cache.read<any[]>(listKey)) ?? [];
  }
  if (selected?.id !== deviceId || workspace?.id !== workspaceId) return;
  sessionList = list;
  renderSessions();
}
function renderSessions() {
  const list = filterSessions(sessionList, workspace, search, projectFilter);
  const count = document.querySelector('#session-count');
  if (count) count.textContent = workspace ? `${list.length} 个会话 · 最近活动优先` : '';
  renderInto(
    '#sessions',
    list.length
      ? list
          .map((s) => {
            const project = workspace?.projects.find((p) => p.id === s.project?.localProjectId);
            return `<button class="session ${sessionId === s.id ? 'selected' : ''}" data-session="${esc(s.id)}"><span>${esc(s.title ?? '新会话')}</span><small>${esc(project?.name ?? '项目')} · ${new Date(s.lastMessageAt ?? s.createdAt ?? 0).toLocaleDateString()}</small></button>`;
          })
          .join('')
      : `<p class="empty">${search || projectFilter ? '没有匹配的会话，试试其他关键词或项目。' : '这里会显示这台电脑的会话。'}</p>`,
  );
  document
    .querySelectorAll<HTMLElement>('[data-session]')
    .forEach((el) => (el.onclick = () => run(() => openSession(el.dataset.session!))));
}
async function openSession(id: string) {
  if (!workspace) return;
  rendered.delete($('#history'));
  const generation = ++sessionGeneration;
  sessionId = id;
  root.removeAttribute('data-nav-open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
  $('#nav-shade').hidden = true;
  void persistSelection().catch(error);
  watch();
  doc = new LoroDoc();
  flock = new Flock();
  meta = null;
  const restored = await cache.read<Mutation>(key('pending'));
  if (generation !== sessionGeneration) return;
  pending = restored;
  renderSessions();
  $('#target').innerHTML =
    `<div><span class="eyebrow">执行电脑</span><h2>${esc(selected?.name)}</h2></div><span>${esc(workspace.name)}</span>`;
  $<HTMLFormElement>('#composer').hidden = false;
  const draft = await cache.read<string>(key('draft'));
  if (generation !== sessionGeneration) return;
  $<HTMLTextAreaElement>('#prompt').value = draft ?? '';
  $('#new-options').innerHTML = id
    ? ''
    : `<label>项目<select id="project">${workspace.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>Agent<select id="agent">${workspace.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label>`;
  if (!id) {
    const options = await cache.read<{ project: string; agent: string }>(key('options'));
    if (generation !== sessionGeneration) return;
    const project = projectFilter || options?.project;
    if (workspace.projects.some((p) => p.id === project))
      $<HTMLSelectElement>('#project').value = project!;
    if (workspace.agents.some((a) => a.id === options?.agent))
      $<HTMLSelectElement>('#agent').value = options!.agent;
    for (const selector of ['#project', '#agent'])
      $(selector).onchange = () => {
        void cache
          .write(key('options'), {
            project: $<HTMLSelectElement>('#project').value,
            agent: $<HTMLSelectElement>('#agent').value,
          })
          .catch(error);
      };
  }
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
            )}${renderFileChanges(turn.fileDiff, turn.id + '/files')}${turn.role === 'assistant' && !turn.finished ? '<span class="working">● Agent 正在处理</span>' : ''}</article>`,
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
function updateComposer() {
  document
    .querySelectorAll<HTMLButtonElement>('[data-permission]')
    .forEach((b) => (b.disabled = sending || !!pending || !connected || !selected?.online));
  const create = document.querySelector<HTMLButtonElement>('#new');
  if (create) create.disabled = !workspace;
  const send = document.querySelector<HTMLButtonElement>('#send');
  if (!send) return;
  send.disabled =
    sending ||
    !connected ||
    !selected?.online ||
    (!pending && (!workspace?.agents.length || (!sessionId && !workspace?.projects.length)));
  send.textContent = sending ? '提交中…' : pending ? '重试确认' : '发送 ↑';
  $<HTMLTextAreaElement>('#prompt').readOnly = sending || !!pending;
  const state = document.querySelector('#draft-state');
  if (state)
    state.textContent = pending
      ? '提交结果待确认，重试会使用同一编号'
      : !connected || !selected?.online
        ? '执行电脑离线 · 输入保留为草稿'
        : '输入保存在当前设备';
  let active = false;
  if (sessionId) {
    const v = mirror(doc, sessionId);
    active = v.getState().history.some((t) => t.role === 'assistant' && !t.finished);
    v.dispose();
  }
  if (active && !pending) send.disabled = true;
  if (active && state && !pending && selected?.online && connected)
    state.textContent = 'Agent 正在处理 · 下一条指令保留为草稿';
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
  const id = sessionId || crypto.randomUUID(),
    agent = workspace.agents.find(
      (a) => a.id === (meta?.agentConfigId ?? $<HTMLSelectElement>('#agent')?.value),
    );
  if (!agent) throw new Error('这台电脑还没有可用的 Agent 配置');
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
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
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
