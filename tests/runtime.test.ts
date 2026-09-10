import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { acpDriver } from '../src/runtime/acp';
import { Flock, LoroDoc, delta, mirror, metas, putMeta, vv } from '../src/model';
import type { Mutation } from '../src/protocol';
test('Moor host persists and resumes a complete ACP conversation with exact permission delivery', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-end-to-end-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'host.sqlite');
  let store = new RuntimeStore(file);
  const projectId = store.registerProject(cwd);
  store.machine.set(['agentConfig', 'synthetic'], {
    id: 'synthetic',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: process.execPath, args: [resolve('scripts/synthetic-agent.mjs')] },
  });
  store.saveMachine();
  let observe = () => {};
  let host = new HostWorkspace(
    store,
    acpDriver,
    () => {},
    () => observe(),
  );
  t.after(() => {
    host.close();
    store.close();
  });
  const sessionId = 'conversation';
  function state() {
    const view = mirror(host.active.get(sessionId)?.doc ?? store.doc(sessionId), sessionId);
    const value = structuredClone(view.getState());
    view.dispose();
    return value;
  }
  for (let round = 0; round < 2; round++) {
    const doc = store.doc(sessionId),
      version = vv(doc),
      view = mirror(doc, sessionId),
      userTurnId = crypto.randomUUID();
    const meta = Flock.fromFile(store.meta.exportFile()),
      before = meta.version();
    const old = metas(meta)['session-' + sessionId];
    view.setState(
      (s: any) =>
        void s.history.push({
          id: userTurnId,
          userId: store.workspace.userId,
          role: 'user',
          timestamp: new Date().toISOString(),
          finished: true,
          status: 'pending',
          fileDiff: null,
          items: [{ type: 'text', text: 'synthetic' }],
          inputConfig: {
            prompt: 'synthetic',
            cliType: 'custom',
            agentType: 'synthetic',
            mcpServerIds: [],
            taskToolsEnabled: false,
          },
        }),
    );
    view.dispose();
    doc.commit();
    putMeta(
      meta,
      'session-' + sessionId,
      old
        ? { latestUserMsgId: userTurnId, lastMessageAt: round }
        : {
            id: sessionId,
            machineId: store.workspace.machineId,
            userId: store.workspace.userId,
            createdAt: new Date().toISOString(),
            cliType: 'custom',
            agentType: 'synthetic',
            agentConfigId: 'synthetic',
            project: { kind: 'local', localProjectId: projectId },
            status: { type: 'idle' },
            isArchived: false,
            latestUserMsgId: userTurnId,
            lastMessageAt: round,
          },
    );
    const request: Mutation = {
      operationId: crypto.randomUUID(),
      workspaceId: store.workspace.id,
      sessionId,
      kind: 'turn',
      expectedTurnId: (old?.latestUserMsgId as string) ?? null,
      update: delta(doc, version),
      metaBundle: meta.exportJson(before),
    };
    const permissionReady = new Promise<void>((resolve) => {
      observe = () => {
        if (
          state()
            .history.at(-1)
            ?.items?.some((i: any) => i.permissionRequest)
        )
          resolve();
      };
    });
    assert.equal((await host.mutate(request, projectId)).delivered, true);
    await permissionReady;
    const run = host.active.get(sessionId)!;
    const choice = new LoroDoc();
    choice.import(run.doc.export({ mode: 'snapshot' }));
    const choiceVersion = vv(choice),
      choiceView = mirror(choice, sessionId);
    let requestId = '';
    choiceView.setState((s: any) => {
      const item = s.history.at(-1).items.find((i: any) => i.permissionRequest);
      requestId = item.permissionRequest.requestId;
      item.permissionRequest.outcome = { outcome: 'selected', optionId: 'allow' };
    });
    choiceView.dispose();
    choice.commit();
    assert.equal(
      (
        await host.mutate(
          {
            ...request,
            operationId: crypto.randomUUID(),
            expectedTurnId: userTurnId,
            kind: 'permission',
            requestId,
            update: delta(choice, choiceVersion),
            metaBundle: undefined,
          },
          projectId,
        )
      ).delivered,
      true,
    );
    await run.done;
    assert.equal(state().history.length, (round + 1) * 2);
    assert.ok(state().history.at(-1)!.finished);
    assert.ok(!JSON.stringify(state()).includes('synthetic historical replay'));
    assert.equal((await host.mutate(request, projectId)).delivered, true);
    const nativeId = store.nativeSession(sessionId);
    assert.ok(nativeId);
    host.close();
    store.close();
    store = new RuntimeStore(file);
    assert.equal(store.nativeSession(sessionId), nativeId);
    host = new HostWorkspace(
      store,
      acpDriver,
      () => {},
      () => observe(),
    );
    assert.equal(host.active.size, 0);
  }
});
