import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type {
  AgentCallbacks,
  AgentRunBinding,
  AgentSession,
  AgentSteerResult,
} from '../src/runtime/agent';
import { runtimeFeatureReport, type SessionEvent } from '../src/runtime/session-events';
import type { QuestionAnswer, QuestionRequest } from '../src/interaction-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';

const scope = { workspaceId: 'workspace', localProjectId: 'project', sessionId: 'session' };
function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const commands = {
  version: 1,
  source: 'acp',
  kind: 'commands',
  commands: [{ name: 'explain', description: 'Synthetic command' }],
} satisfies SessionEvent;
function fixture(t: { after(fn: () => unknown): void }, supportSteer = true) {
  const store = new RuntimeStore(':memory:');
  Object.assign(store.workspace, {
    id: scope.workspaceId,
    userId: 'local:synthetic',
    machineId: 'machine',
  });
  store.machine.set(['localProject', scope.localProjectId], {
    id: scope.localProjectId,
    name: 'Synthetic',
    rootPath: '/synthetic/project',
  });
  store.machine.set(['agentConfig', 'agent'], {
    id: 'agent',
    name: 'Synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    machineId: 'machine',
  });
  store.saveMachine();
  let callbacks!: AgentCallbacks,
    session!: AgentSession,
    calls = 0,
    promptCalls = 0;
  let started = signal<AgentRunBinding>(),
    release = signal();
  let onSteer = async (): Promise<AgentSteerResult> => ({ outcome: 'injected' });
  const host = new HostWorkspace(
    store,
    {
      async open(_config, _root, _native, value) {
        callbacks = value;
        release = signal();
        return (session = {
          id: 'native',
          capabilities: syntheticCapabilities,
          runtimeFeatures: runtimeFeatureReport({}),
          interactionCapabilities: {
            questions: true,
            steer: supportSteer,
            ...(!supportSteer ? { steerUnavailableReason: 'Synthetic unsupported adapter' } : {}),
          },
          currentEvents: { version: 1, plans: [], commands: commands.commands },
          async prompt(_input, binding) {
            promptCalls++;
            started.resolve(binding!);
            await release.promise;
          },
          async steer() {
            calls++;
            return onSteer();
          },
          async cancel() {
            release.resolve();
          },
          close() {
            release.resolve();
          },
        });
      },
    },
    () => {},
    () => {},
    async () => {
      throw new Error('No current filesystem access');
    },
    {
      capture: async () => ({
        version: 1,
        source: 'git',
        partial: false,
        enumerationComplete: true,
        issues: [],
        files: [],
        bytesRead: 0,
      }),
      tree: async () => {
        throw new Error('No current filesystem access');
      },
    },
  );
  t.after(() => {
    host.close();
    store.close();
  });
  const turns = () => {
    const view = mirror(store.doc(scope.sessionId), scope.sessionId),
      history = structuredClone(view.getState().history);
    view.dispose();
    return history;
  };
  async function start() {
    started = signal();
    const doc = store.doc(scope.sessionId),
      before = vv(doc),
      flock = Flock.fromFile(store.meta.exportFile()),
      version = flock.version();
    const old = metas(flock)['session-' + scope.sessionId],
      turnId = randomUUID(),
      view = mirror(doc, scope.sessionId);
    view.setState((state: any) => {
      state.history.push({
        id: turnId,
        role: 'user',
        userId: 'local:synthetic',
        timestamp: '2026-01-01T00:00:00Z',
        status: 'pending',
        finished: true,
        items: [{ type: 'text', text: 'Synthetic prompt' }],
        fileDiff: null,
        inputConfig: {
          prompt: 'Synthetic prompt',
          cliType: 'builtin',
          agentType: 'codex',
          mcpServerIds: [],
          taskToolsEnabled: false,
        },
      });
    });
    view.dispose();
    doc.commit();
    putMeta(
      flock,
      'session-' + scope.sessionId,
      old
        ? { latestUserMsgId: turnId, lastMessageAt: 100 }
        : {
            id: scope.sessionId,
            userId: 'local:synthetic',
            machineId: 'machine',
            createdAt: '2026-01-01T00:00:00Z',
            cliType: 'builtin',
            agentType: 'codex',
            agentConfigId: 'agent',
            project: { kind: 'local', localProjectId: scope.localProjectId },
            status: { type: 'idle' },
            isArchived: false,
            latestUserMsgId: turnId,
            lastMessageAt: 100,
          },
    );
    await host.mutate(
      {
        operationId: randomUUID(),
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        kind: 'turn',
        expectedTurnId: (old?.latestUserMsgId as string) ?? null,
        update: delta(doc, before),
        metaBundle: flock.exportJson(version),
      },
      scope.localProjectId,
    );
    return started.promise;
  }
  return {
    store,
    host,
    start,
    turns,
    get callbacks() {
      return callbacks;
    },
    get session() {
      return session;
    },
    calls: () => calls,
    promptCalls: () => promptCalls,
    setSteer(fn: typeof onSteer) {
      onSteer = fn;
    },
    async finish() {
      const done = host.active.get(scope.sessionId)?.done;
      release.resolve();
      await done;
    },
    turn: () => turns().at(-1)!,
  };
}
const question = (binding: AgentRunBinding, requestId = 'question'): QuestionRequest => ({
  ...binding,
  interactionVersion: 1,
  requestId,
  message: 'Synthetic question',
  fields: [
    {
      id: 'choice',
      label: 'Choose',
      kind: 'single-select',
      required: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ],
});
const answer = (request: QuestionRequest): QuestionAnswer => ({
  ...scope,
  expectedTurnId: request.expectedTurnId,
  interactionVersion: 1,
  operationId: 'answer',
  requestId: request.requestId,
  answer: { action: 'accept', values: { choice: 'b' } },
});

test('actual Host freezes validated initialization and exact-turn events without dispatching startup commands', async (t) => {
  const f = fixture(t),
    binding = await f.start();
  assert.deepEqual(binding, { ...scope, expectedTurnId: f.turn().id });
  let items = f.turn().items as any[];
  assert.equal(
    items.find((item) => item.type === 'agent_features').interactionCapabilities.steer,
    true,
  );
  assert.deepEqual(items.find((item) => item.type === 'session_event').event, commands);
  const event: SessionEvent = {
    version: 1,
    source: 'acp',
    kind: 'context-usage',
    used: 20,
    size: 100,
  };
  f.callbacks.event!(event, { ...binding, expectedTurnId: 'stale' });
  f.callbacks.event!({ ...event, used: -1 }, binding);
  assert.equal(
    (f.turn().items as any[]).filter((item) => item.event?.kind === 'context-usage').length,
    0,
  );
  f.callbacks.event!(event, binding);
  f.callbacks.event!({ ...event, used: 30 }, binding);
  items = f.turn().items as any[];
  assert.equal(items.filter((item) => item.event?.kind === 'context-usage').length, 1);
  assert.equal(items.find((item) => item.event?.kind === 'context-usage').event.used, 30);
  const oldCallbacks = f.callbacks;
  await f.finish();
  const frozen = f.turn();
  oldCallbacks.event!({ ...event, used: 80 }, binding);
  assert.deepEqual(f.turn(), frozen);
  const next = await f.start();
  oldCallbacks.event!({ ...event, used: 99 }, binding);
  f.callbacks.event!({ ...event, used: 5 }, next);
  assert.deepEqual(
    f.turns().find((turn) => turn.id === frozen.id),
    frozen,
  );
  assert.equal(f.promptCalls(), 2);
  await f.finish();
});

test('actual Host question commits answer and receipt before resolving native callback and original retries resolve once', async (t) => {
  const f = fixture(t),
    binding = await f.start(),
    request = question(binding);
  let resolved = 0;
  const native = f.callbacks.question!(request).then((value) => {
    resolved++;
    assert.equal(f.store.journal.has('answer'), true);
    assert.equal(
      (f.turn().items as any[]).find((item) => item.type === 'question').status,
      'answered',
    );
    return value;
  });
  await f.host.serial(scope.sessionId, async () => {});
  assert.equal(resolved, 0);
  const receipts = await Promise.all([
    f.host.answerQuestion(answer(request)),
    f.host.answerQuestion(answer(request)),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal((await native).answer.action, 'accept');
  assert.equal(resolved, 1);
  await f.finish();
  assert.deepEqual(await f.host.answerQuestion(answer(request)), receipts[0]);
});

test('actual Host failed answer receipt rolls back both durable and active documents and cancellation releases native question', async (t) => {
  const f = fixture(t),
    binding = await f.start(),
    request = question(binding);
  const native = f.callbacks.question!(request);
  await f.host.serial(scope.sessionId, async () => {});
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_answer BEFORE INSERT ON operation WHEN NEW.id='answer' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(f.host.answerQuestion(answer(request)));
  assert.equal(f.store.journal.has('answer'), false);
  assert.equal(
    (f.turn().items as any[]).find((item) => item.type === 'question').status,
    'pending',
  );
  const activeView = mirror(f.host.active.get(scope.sessionId)!.doc, scope.sessionId);
  assert.equal(
    (activeView.getState().history.at(-1)!.items as any[]).find((item) => item.type === 'question')
      .status,
    'pending',
  );
  activeView.dispose();
  await f.host.cancel(scope.sessionId, binding.expectedTurnId, scope.localProjectId);
  assert.equal((await native).answer.action, 'cancel');
  assert.equal(
    (f.turn().items as any[]).find((item) => item.type === 'question').status,
    'cancelled',
  );
  await assert.rejects(f.host.answerQuestion(answer(request)));
});

test('actual Host rejects a callback for another scope and suppresses events after lease replacement', async (t) => {
  const f = fixture(t),
    binding = await f.start();
  assert.equal(
    (await f.callbacks.question!(question({ ...binding, sessionId: 'other' }))).answer.action,
    'cancel',
  );
  f.store.workspace.userId = 'revoked-owner';
  f.callbacks.event!(commands, binding);
  assert.equal((f.turn().items as any[]).filter((item) => item.type === 'question').length, 0);
  f.store.workspace.userId = 'local:synthetic';
  await f.finish();
});

test('actual Host stages steer before one native call, persists confirmation and never turns promptRequired into a new prompt', async (t) => {
  const f = fixture(t),
    binding = await f.start(),
    request = { ...binding, operationId: 'steer', prompt: 'Additional instruction' };
  f.setSteer(async () => {
    assert.equal(
      f.store.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get('steer')!.phase,
      'steer-staged',
    );
    assert.equal((f.turn().items as any[]).find((item) => item.type === 'steer').status, 'pending');
    return { outcome: 'injected' };
  });
  const receipt = await f.host.steer(request);
  assert.deepEqual(await f.host.steer(request), receipt);
  assert.equal(f.calls(), 1);
  assert.equal((f.turn().items as any[]).find((item) => item.type === 'steer').status, 'delivered');
  f.setSteer(async () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }));
  await assert.rejects(f.host.steer({ ...request, operationId: 'rejected-steer' }));
  await assert.rejects(f.host.steer({ ...request, operationId: 'rejected-steer' }));
  assert.equal(f.calls(), 2);
  assert.equal(f.promptCalls(), 1);
  assert.equal(
    (f.turn().items as any[]).find((item) => item.operationId === 'rejected-steer').status,
    'not-injected',
  );
  await f.finish();
});

test('actual Host unsupported steer is rejected before journal writes or native actions', async (t) => {
  const f = fixture(t, false),
    binding = await f.start();
  await assert.rejects(
    f.host.steer({ ...binding, operationId: 'unsupported', prompt: 'Additional instruction' }),
  );
  assert.equal(f.store.journal.has('unsupported'), false);
  assert.equal(f.calls(), 0);
  await f.finish();
});

test('actual Host cancellation does not wait for pending steer and late confirmation cannot edit a replacement turn', async (t) => {
  const f = fixture(t),
    binding = await f.start(),
    called = signal(),
    completion = signal<AgentSteerResult>();
  f.setSteer(() => {
    called.resolve();
    return completion.promise;
  });
  const request = { ...binding, operationId: 'late-steer', prompt: 'Additional instruction' },
    pending = f.host.steer(request);
  await called.promise;
  await f.host.cancel(scope.sessionId, binding.expectedTurnId);
  assert.equal((f.turn().items as any[]).find((item) => item.type === 'steer').status, 'unknown');
  const next = await f.start(),
    before = f.turn();
  completion.resolve({ outcome: 'injected' });
  assert.equal((await pending).delivered, true);
  assert.equal(f.turn().id, next.expectedTurnId);
  assert.deepEqual(f.turn(), before);
  assert.deepEqual(await f.host.steer(request), await pending);
  await f.finish();
});
