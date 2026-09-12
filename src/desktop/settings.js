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
