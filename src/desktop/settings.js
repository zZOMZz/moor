const $ = (id) => document.getElementById(id);
let projects = [];
let notificationsEnabled = false,
  notificationsSupported = false,
  notificationsBusy = false;
const status = (value) => ($('status').textContent = value);
function render() {
  const list = $('projects');
  list.replaceChildren();
  for (const p of projects) {
    const li = document.createElement('li'),
      text = document.createElement('span'),
      button = document.createElement('button');
    text.textContent = p;
    button.type = 'button';
    button.textContent = '移除';
    button.onclick = () => {
      projects = projects.filter((x) => x !== p);
      render();
    };
    li.append(text, button);
    list.append(li);
  }
}
window.personal
  .settings()
  .then((s) => {
    $('name').value = s.name;
    $('server').value = s.server;
    projects = s.projects;
    for (const a of s.agents) $(a).checked = true;
    render();
    renderHealth(s.health);
  })
  .catch((e) => status(e.message));
$('add').onclick = async () => {
  try {
    const p = await window.personal.project();
    if (p && !projects.includes(p)) {
      projects.push(p);
      render();
    }
  } catch (e) {
    status(e.message);
  }
};
$('settings').onsubmit = async (e) => {
  e.preventDefault();
  $('save').disabled = true;
  status('正在保存…');
  try {
    const r = await window.personal.save({
      server: $('server').value,
      name: $('name').value,
      code: $('code').value,
      projects,
      agents: ['codex', 'claude'].filter((a) => $(a).checked),
    });
    $('code').value = '';
    status(r.paired ? '设备已配对。可以打开“我的所有电脑”。' : '设置已保存。本机任务会继续运行。');
  } catch (e) {
    status(e.message);
  } finally {
    $('save').disabled = false;
  }
};
$('local').onclick = () => window.personal.open('local');
$('remote').onclick = () => window.personal.open('remote');

function renderHealth(value) {
  if (value.notifications && !notificationsBusy) renderNotifications(value.notifications);
  const cards = $('health-cards');
  const labels = { host: '执行组件', local: '本机工作区', relay: '中转服务' };
  const signature = JSON.stringify(value);
  if (cards.dataset.state === signature) return;
  cards.dataset.state = signature;
  cards.replaceChildren();
  for (const key of ['host', 'local', 'relay']) {
    const item = value[key],
      card = document.createElement('div'),
      heading = document.createElement('strong'),
      description = document.createElement('p');
    card.className = 'health-card';
    card.dataset.state = item.state;
    heading.textContent = labels[key];
    description.textContent = item.message;
    card.append(heading, description);
    cards.append(card);
  }
  $('recover').disabled = value.recovering;
}
async function refreshHealth() {
  if (document.visibilityState !== 'visible') return;
  try {
    renderHealth(await window.personal.health());
  } catch {
    status('无法读取连接状态，请重新打开设置。');
  }
}
$('recover').onclick = async () => {
  $('recover').disabled = true;
  try {
    await window.personal.recover();
    status('已请求重新连接。进行中的任务不会重放。');
  } catch (e) {
    status(e.message);
  } finally {
    await refreshHealth();
    $('recover').disabled = false;
  }
};
void refreshHealth();
const healthTimer = setInterval(refreshHealth, 1500);
window.addEventListener('focus', refreshHealth);
window.addEventListener('beforeunload', () => clearInterval(healthTimer));

function renderNotifications(value) {
  notificationsEnabled = value.enabled;
  notificationsSupported = value.supported;
  for (const kind of ['completed', 'failed', 'approvals'])
    $('notify-' + kind).checked = value[kind];
  $('notifications-enable').hidden = value.enabled;
  $('notifications-disable').hidden = !value.enabled;
  $('notifications-test').disabled = !value.enabled || notificationsBusy || !value.supported;
  $('notifications-status').textContent = value.supported
    ? value.message
    : '当前系统不支持原生通知。';
}
async function changeNotifications(enabled, test = false) {
  if (notificationsBusy) return;
  notificationsBusy = true;
  for (const id of [
    'notifications-enable',
    'notifications-disable',
    'notifications-test',
    'notification-kinds',
  ])
    $(id).disabled = true;
  try {
    const preferences = { enabled };
    for (const kind of ['completed', 'failed', 'approvals'])
      preferences[kind] = $('notify-' + kind).checked;
    let state = await window.personal.notificationSettings(preferences);
    if (test && state.supported) state = await window.personal.notificationTest();
    renderNotifications(state);
  } catch (error) {
    $('notifications-status').textContent = error.message;
  } finally {
    notificationsBusy = false;
    for (const id of [
      'notifications-enable',
      'notifications-disable',
      'notifications-test',
      'notification-kinds',
    ])
      $(id).disabled = false;
    $('notifications-test').disabled = !notificationsEnabled || !notificationsSupported;
  }
}
$('notifications-enable').onclick = () => changeNotifications(true, true);
$('notifications-disable').onclick = () => changeNotifications(false);
for (const kind of ['completed', 'failed', 'approvals'])
  $('notify-' + kind).onchange = () => changeNotifications(notificationsEnabled);
$('notifications-test').onclick = async () => {
  if (notificationsBusy) return;
  notificationsBusy = true;
  $('notifications-test').disabled = true;
  try {
    renderNotifications(await window.personal.notificationTest());
  } catch (error) {
    $('notifications-status').textContent = error.message;
  } finally {
    notificationsBusy = false;
    $('notifications-test').disabled = !notificationsEnabled || !notificationsSupported;
  }
};

let githubState,
  githubBusy = false,
  githubRevision = 0,
  githubClosed = false;
const githubStatusLabels = {
  unchecked: '尚未验证',
  connected: '已连接',
  denied: '访问或仓库身份未确认',
  unavailable: '连接不可用或登记已变化',
};
function optionsFor(id, values, selected, empty) {
  const select = $(id);
  select.replaceChildren();
  if (empty) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = empty;
    select.append(option);
  }
  for (const item of values) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = values.some((value) => value.id === selected)
    ? selected
    : empty
      ? ''
      : (values[0]?.id ?? '');
}
function renderGitHubCredential() {
  const credential = githubState?.credentials.find((c) => c.id === $('github-credential').value);
  $('github-label').value = credential?.label ?? '';
  $('github-token').value = '';
  $('github-credential-status').textContent = credential
    ? '已保存 token（不回显）。' +
      githubStatusLabels[credential.status.state] +
      (credential.status.login ? '：' + credential.status.login : '')
    : '填写新的备注名称和 token；保存后可手动检查连接。';
  $('github-credential-save').textContent = credential ? '替换此 token' : '保存新 token';
  $('github-credential-check').disabled = !credential;
  $('github-credential-remove').disabled = !credential;
}
function renderGitHubProject() {
  const project = githubState?.projects.find((p) => p.id === $('github-project').value),
    binding = project?.binding;
  optionsFor(
    'github-project-credential',
    githubState?.credentials.map((c) => ({ id: c.id, label: c.label })) ?? [],
    binding?.credentialId,
  );
  $('github-owner').value = binding?.owner ?? '';
  $('github-repo').value = binding?.repo ?? '';
  $('github-project-status').textContent = !project
    ? '暂无已保存的项目，请先添加并保存本机项目。'
    : !binding
      ? '此项目尚未登记 GitHub 仓库。'
      : `${binding.owner}/${binding.repo}：${githubStatusLabels[binding.status.state]}${binding.repositoryId ? '（仓库编号 ' + binding.repositoryId + '）' : ''}`;
  $('github-project-bind').disabled = !project || !githubState.credentials.length;
  $('github-project-check').disabled = !binding || !binding.current;
  $('github-project-unbind').disabled = !binding;
  $('github-project-writes').disabled =
    !binding ||
    (!binding.writesEnabled && (!binding.current || binding.status.state !== 'connected'));
  $('github-project-writes').textContent = binding?.writesEnabled
    ? '停用评论、推送与 PR 写入'
    : '启用评论、推送与 PR 写入';
}
function renderGitHub(value, action) {
  githubState = value;
  const selectedCredential =
    $('github-credential').value ||
    (action?.action === 'credential-save' ? value.credentials.at(-1)?.id : '');
  optionsFor(
    'github-credential',
    value.credentials.map((c) => ({ id: c.id, label: c.label })),
    selectedCredential,
    '新增凭据',
  );
  optionsFor(
    'github-project',
    value.projects.map((p) => ({ id: p.id, label: p.name + ' — ' + p.rootPath })),
    $('github-project').value,
  );
  renderGitHubCredential();
  renderGitHubProject();
  $('github-status').textContent =
    action?.action === 'read'
      ? '已读取执行电脑的配置。检查与保存仅在手动操作时执行。'
      : '本机配置已更新，请查看账号和项目的验证状态。';
}
async function githubAction(action) {
  if (githubBusy || githubClosed) return;
  githubBusy = true;
  const revision = ++githubRevision;
  $('github-controls').disabled = true;
  $('github-project-controls').disabled = true;
  $('github-refresh').disabled = true;
  $('github-status').textContent = '正在处理本机 GitHub 设置…';
  try {
    const value = await window.personal.githubConfig(action);
    if (githubClosed || revision !== githubRevision) return;
    renderGitHub(value, action);
  } catch (error) {
    if (githubClosed || revision !== githubRevision) return;
    githubState = undefined;
    $('github-status').textContent =
      (error.message || '操作结果尚未确认') + '。请刷新本机 GitHub 设置后检查；不会自动重试。';
  } finally {
    if (!githubClosed && revision === githubRevision) {
      githubBusy = false;
      $('github-controls').disabled = !githubState;
      $('github-project-controls').disabled = !githubState;
      $('github-refresh').disabled = false;
    }
  }
}
function githubEdit(action) {
  if (!githubState || githubBusy) return;
  return githubAction({ expectedRevision: githubState.revision, ...action });
}
$('github-settings').ontoggle = () => {
  if ($('github-settings').open && !githubState && !githubBusy)
    void githubAction({ action: 'read' });
};
$('github-refresh').onclick = () => githubAction({ action: 'read' });
$('github-credential').onchange = renderGitHubCredential;
$('github-project').onchange = renderGitHubProject;
$('github-credential-save').onclick = () => {
  const token = $('github-token').value,
    label = $('github-label').value.trim(),
    credentialId = $('github-credential').value;
  $('github-token').value = '';
  if (!token || !label) {
    $('github-status').textContent = '请填写备注名称及新的 token。';
    return;
  }
  return githubEdit({
    action: 'credential-save',
    label,
    token,
    ...(credentialId ? { credentialId } : {}),
  });
};
for (const action of ['credential-check', 'credential-remove'])
  $('github-' + action).onclick = () =>
    githubEdit({ action, credentialId: $('github-credential').value });
$('github-project-bind').onclick = () =>
  githubEdit({
    action: 'project-bind',
    localProjectId: $('github-project').value,
    credentialId: $('github-project-credential').value,
    owner: $('github-owner').value.trim(),
    repo: $('github-repo').value.trim(),
  });
for (const action of ['project-check', 'project-unbind'])
  $('github-' + action).onclick = () =>
    githubEdit({ action, localProjectId: $('github-project').value });
$('github-project-writes').onclick = () => {
  const project = githubState?.projects.find((p) => p.id === $('github-project').value);
  if (!project?.binding) return;
  return githubEdit({
    action: 'project-writes',
    localProjectId: project.id,
    enabled: !project.binding.writesEnabled,
  });
};
window.addEventListener('beforeunload', () => {
  githubClosed = true;
  githubRevision++;
  $('github-token').value = '';
});

let previewState,
  previewBusy = false,
  previewRevision = 0,
  previewClosed = false;
const previewTargetKey = (target) => JSON.stringify([target.localProjectId, target.executionId]);
function renderPreviewRoot() {
  const target = previewState?.targets.find(
    (t) => previewTargetKey(t) === $('preview-target').value,
  );
  $('preview-root').textContent = target
    ? target.rootPath
    : '此执行目录当前不可用，请刷新或删除旧登记。';
  $('preview-save').disabled = !target;
}
function renderPreviewService() {
  const service = previewState?.services.find((s) => s.id === $('preview-service').value);
  optionsFor(
    'preview-target',
    previewState?.targets.map((t) => ({ id: previewTargetKey(t), label: t.label })) ?? [],
    service ? previewTargetKey(service) : $('preview-target').value,
  );
  // Do not silently replace a removed worktree with the first available target.
  if (
    service &&
    !previewState.targets.some((t) => previewTargetKey(t) === previewTargetKey(service))
  )
    $('preview-target').value = '';
  $('preview-target').disabled = !!service;
  $('preview-label').value = service?.label ?? '';
  $('preview-address').value = service?.address ?? '127.0.0.1';
  $('preview-port').value = service ? String(service.port) : '';
  $('preview-path').value = service?.startPath ?? '/';
  $('preview-enabled').checked = service?.enabled ?? false;
  $('preview-service-status').textContent = !service
    ? '填写服务地址，并确认它由所选目录启动。'
    : !service.current
      ? '原执行目录或地址已变化；此登记不可用于预览。'
      : service.enabled
        ? '登记已启用。连接与目录对应关系由你确认。'
        : '登记已停用。';
  $('preview-save').textContent = service ? '保存服务登记' : '登记服务';
  $('preview-remove').disabled = !service;
  $('preview-toggle').disabled = !service || (!service.enabled && !service.current);
  $('preview-toggle').textContent = service?.enabled ? '停用服务' : '启用服务';
  renderPreviewRoot();
}
function renderPreview(value, action) {
  previewState = value;
  const selected =
    $('preview-service').value ||
    (action.action === 'service-save' ? value.services.at(-1)?.id : '');
  optionsFor(
    'preview-service',
    value.services.map((s) => ({
      id: s.id,
      label: s.label + (s.enabled ? '（启用）' : '（停用）'),
    })),
    selected,
    '新增服务',
  );
  renderPreviewService();
  $('preview-status').textContent =
    action.action === 'read'
      ? '已读取本机登记；未探测端口或启动服务。'
      : '本机登记已保存，旧预览已失效。';
}
async function previewAction(action) {
  if (previewBusy || previewClosed) return;
  previewBusy = true;
  const revision = ++previewRevision;
  $('preview-controls').disabled = true;
  $('preview-refresh').disabled = true;
  $('preview-status').textContent = '正在处理本机预览设置…';
  try {
    const value = await window.personal.previewConfig(action);
    if (previewClosed || previewRevision !== revision) return;
    renderPreview(value, action);
  } catch (error) {
    if (previewClosed || previewRevision !== revision) return;
    previewState = undefined;
    $('preview-status').textContent =
      (error.message || '操作结果尚未确认') + '。请刷新后检查；不会自动重试。';
  } finally {
    if (!previewClosed && previewRevision === revision) {
      previewBusy = false;
      $('preview-controls').disabled = !previewState;
      $('preview-refresh').disabled = false;
    }
  }
}
function previewEdit(action) {
  if (!previewState || previewBusy) return;
  return previewAction({ expectedRevision: previewState.revision, ...action });
}
$('preview-settings').ontoggle = () => {
  if ($('preview-settings').open && !previewState && !previewBusy)
    void previewAction({ action: 'read' });
};
$('preview-refresh').onclick = () => previewAction({ action: 'read' });
$('preview-service').onchange = renderPreviewService;
$('preview-target').onchange = renderPreviewRoot;
$('preview-save').onclick = () => {
  const target = previewState?.targets.find(
    (t) => previewTargetKey(t) === $('preview-target').value,
  );
  if (!target) return;
  const id = $('preview-service').value;
  return previewEdit({
    action: 'service-save',
    ...(id ? { id } : {}),
    localProjectId: target.localProjectId,
    executionId: target.executionId,
    label: $('preview-label').value.trim(),
    address: $('preview-address').value,
    port: Number($('preview-port').value),
    startPath: $('preview-path').value,
    enabled: $('preview-enabled').checked,
  });
};
$('preview-remove').onclick = () =>
  previewEdit({ action: 'service-remove', id: $('preview-service').value });
$('preview-toggle').onclick = () => {
  const service = previewState?.services.find((s) => s.id === $('preview-service').value);
  if (service)
    return previewEdit({ action: 'service-enabled', id: service.id, enabled: !service.enabled });
};
window.addEventListener('beforeunload', () => {
  previewClosed = true;
  previewRevision++;
});

let skillsState,
  skillsBusy = false,
  skillsRevision = 0,
  skillsClosed = false;
function renderSkillsSource() {
  const source = skillsState?.sources.find((s) => s.id === $('skills-source').value);
  $('skills-label').value = source?.label ?? '';
  $('skills-root').value = source?.rootPath ?? '';
  $('skills-enabled').checked = source?.enabled ?? false;
  $('skills-source-status').textContent = !source
    ? '选择实际的 Skills 根目录；新登记默认停用。'
    : !source.current
      ? '原目录已变化；请确认路径并重新登记。'
      : source.enabled
        ? '此目录已启用。'
        : '此目录已停用。';
  $('skills-save').textContent = source ? '保存目录登记' : '登记目录';
  $('skills-toggle').disabled = !source || (!source.current && !source.enabled);
  $('skills-toggle').textContent = source?.enabled ? '停用目录' : '启用目录';
  $('skills-remove').disabled = !source;
}
function renderSkills(value, action) {
  skillsState = value;
  const selected =
    $('skills-source').value || (action.action === 'source-save' ? value.sources.at(-1)?.id : '');
  optionsFor(
    'skills-source',
    value.sources.map((s) => ({
      id: s.id,
      label: s.label + (s.enabled ? '（启用）' : '（停用）'),
    })),
    selected,
    '新增目录',
  );
  renderSkillsSource();
  $('skills-status').textContent =
    action.action === 'read' ? '已读取本机登记；未扫描目录或读取 Skill。' : '本机目录登记已保存。';
}
async function skillsAction(action) {
  if (skillsBusy || skillsClosed) return;
  skillsBusy = true;
  const revision = ++skillsRevision;
  $('skills-controls').disabled = true;
  $('skills-refresh').disabled = true;
  $('skills-status').textContent = '正在处理本机 Skills 设置…';
  try {
    const value = await window.personal.skillsConfig(action);
    if (skillsClosed || skillsRevision !== revision) return;
    renderSkills(value, action);
  } catch (error) {
    if (skillsClosed || skillsRevision !== revision) return;
    skillsState = undefined;
    $('skills-status').textContent =
      (error.message || '操作结果尚未确认') + '。请刷新后检查；不会自动重试。';
  } finally {
    if (!skillsClosed && skillsRevision === revision) {
      skillsBusy = false;
      $('skills-controls').disabled = !skillsState;
      $('skills-refresh').disabled = false;
    }
  }
}
function skillsEdit(action) {
  if (!skillsState || skillsBusy) return;
  return skillsAction({ expectedRevision: skillsState.revision, ...action });
}
$('skills-settings').ontoggle = () => {
  if ($('skills-settings').open && !skillsState && !skillsBusy)
    void skillsAction({ action: 'read' });
};
$('skills-refresh').onclick = () => skillsAction({ action: 'read' });
$('skills-source').onchange = renderSkillsSource;
$('skills-save').onclick = () => {
  const id = $('skills-source').value;
  return skillsEdit({
    action: 'source-save',
    ...(id ? { id } : {}),
    label: $('skills-label').value.trim(),
    rootPath: $('skills-root').value,
    enabled: $('skills-enabled').checked,
  });
};
$('skills-choose').onclick = async () => {
  if (skillsBusy || skillsClosed || !skillsState) return;
  skillsBusy = true;
  const revision = ++skillsRevision;
  $('skills-controls').disabled = true;
  $('skills-refresh').disabled = true;
  try {
    const root = await window.personal.skillsDirectory();
    if (root && !skillsClosed && skillsRevision === revision) $('skills-root').value = root;
  } catch (error) {
    if (!skillsClosed && skillsRevision === revision)
      $('skills-status').textContent = error.message || '目录选择失败';
  } finally {
    if (!skillsClosed && skillsRevision === revision) {
      skillsBusy = false;
      $('skills-controls').disabled = !skillsState;
      $('skills-refresh').disabled = false;
    }
  }
};
$('skills-remove').onclick = () =>
  skillsEdit({ action: 'source-remove', id: $('skills-source').value });
$('skills-toggle').onclick = () => {
  const service = skillsState?.sources.find((s) => s.id === $('skills-source').value);
  if (service)
    return skillsEdit({ action: 'source-enabled', id: service.id, enabled: !service.enabled });
};
window.addEventListener('beforeunload', () => {
  skillsClosed = true;
  skillsRevision++;
});
