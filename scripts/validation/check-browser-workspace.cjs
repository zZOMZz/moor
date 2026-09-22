// Real Chromium and IndexedDB against a synthetic local API. Never an Agent or real account.
// Run after build:web; the isolated profile stays in the OS temporary directory for diagnosis.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const repository = path.resolve(__dirname, '../..');
const root = path.join(repository, 'dist/public');
let data;
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'moor-browser-workspace-'));
app.setPath('userData', profile);
let online = true,
  denied = false,
  origin,
  mutations = 0;
const actor = { kind: 'relay', authorityId: 'authority', accountId: 'owner' },
  identity = { owner: 'owner', actor };
let runtime;
const createRuntime = () => ({
  id: 'runtime',
  userId: 'user',
  machineId: 'machine',
  name: 'Host',
  projects: [{ id: 'project', name: 'Synthetic project', rootPath: '/synthetic' }],
  agents: [data.agent],
  features: ['session-page-v1'],
});
const target = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  catalogWorkspaceId: 'catalog',
  catalogProjectId: 'logical',
  replicaId: 'replica',
};
let snapshot;
const createSnapshot = () => ({
  version: 1,
  identity,
  workspaces: [
    {
      id: 'catalog',
      name: 'Workspace',
      hosts: [
        {
          id: 'host',
          deviceId: 'device',
          machineId: 'machine',
          runtimeWorkspaceId: 'runtime',
          name: 'Host',
          online: true,
          agents: [data.agent],
        },
      ],
      projects: [
        { id: 'logical', name: 'Synthetic project' },
        { id: 'logical-other', name: 'Other grouping' },
      ],
      replicas: [
        {
          id: 'replica',
          projectId: 'logical',
          hostId: 'host',
          localProjectId: 'project',
          available: true,
        },
      ],
    },
  ],
  devices: [{ id: 'device', name: 'Host', online: true, workspaces: [runtime] }],
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  const reply = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith('/api/')) {
    if (!online) return reply({ error: 'Synthetic unavailable' }, 503);
    if (denied) return reply({ error: 'Synthetic unauthenticated' }, 401);
    if (url.pathname === '/api/me')
      return reply({
        ...identity,
        localOnly: false,
        needsSetup: false,
        google: { enabled: false },
      });
    if (url.pathname === '/api/workspace-catalog') return reply(snapshot);
    if (url.pathname === '/api/workspaces' && req.method === 'GET')
      return reply(snapshot.workspaces);
    if (url.pathname.endsWith('/context'))
      return reply({ version: 1, identity, target, runtime, mappingVersion: 'a'.repeat(64) });
    if (url.pathname.endsWith('/sessions')) return reply([data.meta]);
    if (url.pathname.endsWith('/sessions/session')) return reply(data);
    if (url.pathname.endsWith('/agent-options')) return reply(data.agent);
    if (url.pathname.endsWith('/sessions-page')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return reply({
        pageVersion: 1,
        workspaceId: 'runtime',
        localProjectId: 'project',
        confirmed: true,
        archived: body.archived || 'active',
        pinned: body.pinned || 'all',
        query: body.query || '',
        limit: body.limit || 30,
        revision: 'sha256:' + 'a'.repeat(64),
        items: body.pinned === 'pinned' ? [] : [data.meta],
        nextCursor: null,
      });
    }
    mutations++;
    return reply({ error: 'Unexpected synthetic API' }, 500);
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + '/') || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader(
    'content-type',
    file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.wasm')
        ? 'application/wasm'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream',
  );
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/events' });
app.whenReady().then(async () => {
  const { LoroDoc, Flock, mirror, putMeta, encode } = await import('@moor/session/model');
  const meta = {
    id: 'session',
    userId: 'user',
    machineId: 'machine',
    project: { kind: 'local', localProjectId: 'project' },
    agentConfigId: 'agent',
    cliType: 'custom',
    agentType: 'synthetic',
    title: 'Synthetic browser session',
  };
  const agent = { id: 'agent', name: 'Synthetic', cliType: 'custom', agentType: 'synthetic' };
  const doc = new LoroDoc(),
    view = mirror(doc, 'session'),
    flock = new Flock();
  view.setState((value) => {
    value.session.id = 'session';
  });
  view.dispose();
  putMeta(flock, 'session-session', meta);
  doc.commit();
  data = {
    meta,
    agent,
    update: encode(doc.export({ mode: 'snapshot' })),
    metaBundle: flock.exportJson(),
    online: true,
    synced: true,
    persisted: true,
  };
  doc.free();
  runtime = createRuntime();
  snapshot = createSnapshot();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const errors = [];
  const timeout = setTimeout(async () => {
    console.error(
      'SMOKE DEADLINE',
      await win.webContents.executeJavaScript('document.body.innerText'),
    );
    console.error(errors);
    app.exit(1);
  }, 30000);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (expression) =>
    js(
      `new Promise((resolve,reject)=>{const check=()=>{const value=(${expression});if(value){observer.disconnect();resolve(true);}};const observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});check();})`,
    );
  try {
    await win.loadURL(origin);
    console.log('page loaded');
    await wait("document.querySelector('.workspace-project')");
    console.log('project shown');
    await js("document.querySelector('.workspace-project').click()");
    await wait("document.querySelector('.workspace-session-open')");
    console.log('session shown');
    await js("document.querySelector('.workspace-session-open').click()");
    await wait(
      "document.querySelector('.workspace-session-header h1')?.textContent==='Synthetic browser session' && document.querySelector('.workspace-composer textarea') && !document.querySelector('.workspace-composer textarea').disabled",
    );
    console.log('session open');
    await js(
      `new Promise(resolve=>{const previous=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const result=previous.apply(this,arguments);if(String(key).includes('moor-desktop-draft-v1')&&value?.value?.text==='Synthetic unsent draft'){this.transaction.addEventListener('complete',()=>{IDBObjectStore.prototype.put=previous;resolve(true);},{once:true});}return result;};const field=document.querySelector('.workspace-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Synthetic unsent draft');field.dispatchEvent(new Event('input',{bubbles:true}));})`,
    );
    console.log('draft committed');
    await js('document.querySelector(\'[aria-label="账号与连接"]\').click()');
    await wait(
      "[...document.querySelectorAll('button')].some(button=>button.textContent==='结束当前查看')",
    );
    await js(
      "[...document.querySelectorAll('button')].find(button=>button.textContent==='结束当前查看').click()",
    );
    await wait(
      "![...document.querySelectorAll('button')].some(button=>button.textContent==='结束当前查看')",
    );
    await js(
      "[...document.querySelectorAll('button')].find(button=>button.textContent==='高级分组管理').click()",
    );
    await wait("document.querySelector('.workspace-catalog-management select[name=projectId]')");
    await js(
      "const field=document.querySelector('.workspace-catalog-management select[name=projectId]');field.value='logical-other';field.form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));",
    );
    await wait(
      "document.querySelector('.workspace-catalog-management [role=alert]')?.textContent.includes('未发送草稿')",
    );
    assert.equal(mutations, 0);
    console.log('saved draft blocks regrouping after leaving its session');
    online = false;
    await win.loadURL(origin);
    console.log('offline page loaded');
    await wait(
      "document.querySelector('.workspace-composer textarea')?.value==='Synthetic unsent draft'",
    );
    const offline = await js(
      "({title:document.querySelector('.workspace-session-header h1')?.textContent,draft:document.querySelector('.workspace-composer textarea')?.value,sendDisabled:[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='发送')?.disabled,secure:!!window.moorSecure})",
    );
    assert.equal(offline.title, 'Synthetic browser session');
    assert.equal(offline.draft, 'Synthetic unsent draft');
    assert.equal(offline.sendDisabled, true);
    assert.equal(offline.secure, false);
    online = true;
    denied = true;
    await win.loadURL(origin);
    console.log('denied page loaded');
    await wait("document.querySelector('#login')");
    assert.equal(mutations, 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        onlineOpened: true,
        regroupingBlockedBySavedDraft: true,
        offline,
        unauthenticatedShowsLogin: true,
        mutations,
        errors,
      }),
    );
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await js('document.body.innerText'));
    app.exit(1);
  }
});
