const $ = (id) => document.getElementById(id);
let projects = [];
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
