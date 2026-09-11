import test, { type TestContext } from 'node:test';
import strict from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createAcceptanceFixture, type AcceptanceFixture } from '../src/acceptance/fixture';
import type { Workspace } from '../src/catalog';
import { Flock, LoroDoc, decode, delta, mirror, putMeta, vv } from '../src/model';
import type { Mutation } from '../src/protocol';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moor-acceptance-fixture-'));
  const publicDir = join(root, 'public');
  const dataDir = join(root, 'data');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Synthetic Moor UI</title>');
  let value: AcceptanceFixture | undefined;
  t.after(async () => {
    try {
      await value?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  value = await createAcceptanceFixture({ publicDir, dataDir });
  const api = (path: string, body?: unknown) =>
    fetch(value!.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: 'personal=' + value!.secret,
        Origin: value!.origin,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const prefix = `/api/workspaces/${value.scope.workspaceId}/replicas/${value.scope.replicaId}`;
  return { ...value, api, prefix, root, publicDir, dataDir };
}

test('acceptance fixture is ready with authenticated real host sessions and scoped catalog', async (t) => {
  const f = await fixture(t);
  strict.equal(new URL(f.origin).hostname, '127.0.0.1');
  strict.notEqual(new URL(f.origin).port, '0');
  strict.deepEqual(await (await f.api('/api/me')).json(), {
    owner: f.scope.accountId,
    localOnly: true,
    needsSetup: false,
  });
  strict.equal((await fetch(f.origin + '/api/workspaces')).status, 401);
  strict.match(await (await fetch(f.origin)).text(), /Synthetic Moor UI/);
  const workspaces = (await (await f.api('/api/workspaces')).json()) as Workspace[];
  strict.equal(workspaces.length, 1);
  const workspace = workspaces[0];
  strict.equal(workspace.id, f.scope.workspaceId);
  strict.equal(workspace.hosts[0].deviceId, f.scope.deviceId);
  strict.equal(workspace.hosts[0].runtimeWorkspaceId, f.scope.runtimeWorkspaceId);
  strict.equal(workspace.hosts[0].online, true);
  strict.equal(workspace.projects[0].id, f.scope.projectId);
  strict.equal(workspace.replicas[0].id, f.scope.replicaId);
  strict.equal(workspace.replicas[0].rootPath, join(f.dataDir, 'project'));
  const sessions = (await (await f.api(f.prefix + '/sessions')).json()) as any[];
  strict.deepEqual(
    sessions.map((session) => session.title).sort(),
    ['会话抽屉验收', '窄屏弹窗验收', '设置保存验收'].sort(),
  );
  for (const session of sessions) {
    const response = await f.api(f.prefix + '/sessions/' + session.id);
    strict.equal(response.status, 200);
    const result = (await response.json()) as any;
    const doc = new LoroDoc();
    doc.import(decode(result.update));
    const view = mirror(doc, session.id);
    strict.equal(view.getState().session.id, session.id);
    strict.equal(view.getState().history.length, 2);
    strict.ok(view.getState().history.every((turn) => turn.finished));
    strict.equal(result.meta.project.localProjectId, workspace.replicas[0].localProjectId);
    strict.equal(result.meta.latestUserMsgId, result.meta.lastHandledUserMsgId);
    strict.equal(result.online, true);
    view.dispose();
  }
  const catalog = new DatabaseSync(join(f.dataDir, 'catalog.sqlite'), { readOnly: true });
  try {
    strict.equal(
      catalog.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session'").get(),
      undefined,
    );
  } finally {
    catalog.close();
  }
});

test('workspace settings persist for the fixture and a fresh fixture starts independently', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const renamed = await first.api('/api/workspaces/' + first.scope.workspaceId + '/rename', {
    name: '已保存的验收名称',
  });
  strict.equal(renamed.status, 200);
  strict.equal(
    ((await (await first.api('/api/workspaces')).json()) as Workspace[])[0].name,
    '已保存的验收名称',
  );
  strict.equal(
    ((await (await second.api('/api/workspaces')).json()) as Workspace[])[0].name,
    '个人工作区',
  );
  strict.notEqual(first.scope.accountId, second.scope.accountId);
  strict.notEqual(first.scope.runtimeWorkspaceId, second.scope.runtimeWorkspaceId);
  strict.notEqual(first.scope.projectId, second.scope.projectId);
  strict.equal(
    (
      await fetch(second.origin + '/api/workspaces', {
        headers: { Cookie: 'personal=' + first.secret },
      })
    ).status,
    401,
  );
  strict.equal((await second.api(first.prefix + '/sessions')).status, 404);
  strict.equal(
    (
      await fetch(first.origin + '/api/workspaces/' + first.scope.workspaceId + '/rename', {
        method: 'POST',
        headers: { Cookie: 'personal=' + first.secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cross-origin' }),
      })
    ).status,
    403,
  );
  await first.close();
  await first.close();
  const catalog = new DatabaseSync(join(first.dataDir, 'catalog.sqlite'), { readOnly: true });
  try {
    strict.equal(
      catalog.prepare('SELECT name FROM workspace WHERE id=?').get(first.scope.workspaceId)?.name,
      '已保存的验收名称',
    );
  } finally {
    catalog.close();
  }
  await strict.rejects(fetch(first.origin + '/api/me'));
});

test(
  'fixture mutations use host validation and the synthetic driver with no project execution',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const sessionPath = f.prefix + '/sessions/' + f.scope.sessionId;
    const original = (await (await f.api(sessionPath)).json()) as any;
    const options = await f.api(f.prefix + '/agent-options', { agentId: 'acceptance-agent' });
    strict.equal(options.status, 200);
    strict.equal(((await options.json()) as any).runConfig.models[0].id, 'acceptance-model');
    const doc = new LoroDoc();
    doc.import(decode(original.update));
    const before = vv(doc);
    const flock = new Flock();
    flock.importJson(original.metaBundle);
    const metaVersion = flock.version();
    const turnId = 'acceptance-manual-user';
    const prompt = '合成验收指令：创建文件并运行项目。';
    const view = mirror(doc, f.scope.sessionId);
    view.setState((state) => {
      state.history.push({
        id: turnId,
        role: 'user',
        timestamp: '2026-01-01T00:01:00Z',
        userId: original.meta.userId,
        userTurnId: undefined,
        status: 'pending',
        read: undefined,
        finished: true,
        items: [{ type: 'text', text: prompt }],
        inputConfig: {
          prompt,
          cliType: 'builtin',
          agentType: 'codex',
          mcpServerIds: [],
          taskToolsEnabled: false,
        },
        fileDiff: null,
      });
    });
    view.dispose();
    doc.commit();
    putMeta(flock, 'session-' + f.scope.sessionId, {
      latestUserMsgId: turnId,
      lastMessageAt: Date.parse('2026-01-01T00:01:00Z'),
    });
    const mutation: Mutation = {
      operationId: 'acceptance-manual-operation',
      sessionId: f.scope.sessionId,
      workspaceId: f.scope.runtimeWorkspaceId,
      kind: 'turn',
      expectedTurnId: original.meta.latestUserMsgId,
      update: delta(doc, before),
      metaBundle: flock.exportJson(metaVersion),
    };
    strict.equal(
      (await f.api(f.prefix + '/mutations', { ...mutation, workspaceId: 'unrelated-workspace' }))
        .status,
      400,
    );
    strict.equal(
      (await f.api(f.prefix + '/cancel', { sessionId: f.scope.sessionId, turnId: 'old-turn' }))
        .status,
      409,
    );
    const events = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
      headers: { Cookie: 'personal=' + f.secret, Origin: f.origin },
    });
    events.on('error', () => {});
    await once(events, 'open');
    const completed = new Promise<void>((resolve, reject) => {
      events.on('message', () => {
        void (async () => {
          const result = (await (await f.api(sessionPath)).json()) as any;
          const current = new LoroDoc();
          current.import(decode(result.update));
          const state = mirror(current, f.scope.sessionId);
          try {
            const reply = state.getState().history.at(-1)!;
            if (reply.userTurnId !== turnId || !reply.finished) return;
            strict.equal(reply.status, 'handled');
            strict.match(JSON.stringify(reply.items), /这是合成回复/);
            resolve();
          } finally {
            state.dispose();
          }
        })().catch(reject);
      });
    });
    const response = await f.api(f.prefix + '/mutations', mutation);
    strict.equal(response.status, 200);
    const receipt = await response.json();
    strict.deepEqual(receipt, {
      accepted: true,
      delivered: true,
      operationId: mutation.operationId,
    });
    await completed;
    strict.deepEqual(await (await f.api(f.prefix + '/mutations', mutation)).json(), receipt);
    strict.deepEqual(readdirSync(join(f.dataDir, 'project')), []);
    events.terminate();
  },
);

test('fixture refuses existing data instead of importing or overwriting it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moor-acceptance-existing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = join(root, 'operator-data.txt');
  writeFileSync(sentinel, 'synthetic operator data');
  await strict.rejects(
    createAcceptanceFixture({ publicDir: root, dataDir: root }),
    /验收数据目录必须为空/,
  );
  strict.deepEqual(readdirSync(root), ['operator-data.txt']);
  strict.equal(readFileSync(sentinel, 'utf8'), 'synthetic operator data');
});
