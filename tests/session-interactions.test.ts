import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/bridge/journal';
import {
  SessionInteractions,
  expireSessionInteractions,
  type InteractionOwner,
  type InteractionRun,
  type InteractionTurn,
} from '../src/bridge/session-interactions';
import { AppError } from '../src/protocol';
import {
  INTERACTION_VERSION,
  type QuestionRequest,
  type QuestionAnswer,
  type SteerRequest,
} from '../src/interaction-protocol';
import type { AgentSteerResult } from '../src/runtime/agent';

const scope = { workspaceId: 'workspace', localProjectId: 'project', sessionId: 'session' };
const question: QuestionRequest = {
  ...scope,
  interactionVersion: INTERACTION_VERSION,
  expectedTurnId: 'turn',
  requestId: 'question',
  message: 'Synthetic question',
  fields: [
    {
      id: 'choice',
      label: 'Choice',
      required: true,
      kind: 'single-select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ],
};
const answer = (operationId = 'answer-op'): QuestionAnswer => ({
  ...scope,
  interactionVersion: INTERACTION_VERSION,
  operationId,
  expectedTurnId: question.expectedTurnId,
  requestId: question.requestId,
  answer: { action: 'accept', values: { choice: 'a' } },
});
const steer = (operationId = 'steer-op'): SteerRequest => ({
  ...scope,
  operationId,
  expectedTurnId: 'turn',
  prompt: 'Synthetic additional instruction',
});
function signal<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Run = InteractionRun & { turn: InteractionTurn };
function fixture(t: { after: (callback: () => unknown) => void }) {
  const journal = new Journal(':memory:');
  t.after(() => journal.close());
  journal.db.exec(
    'CREATE TABLE synthetic_document(session_id TEXT PRIMARY KEY,body TEXT NOT NULL)',
  );
  let owner: InteractionOwner = {
      userId: 'local:synthetic',
      machineId: 'machine',
      rootPath: '/synthetic/project',
    },
    calls = 0;
  let driver = async (): Promise<AgentSteerResult> => ({ outcome: 'injected' });
  let run: Run | undefined = {
    turnId: 'turn',
    stopped: false,
    turn: { id: 'turn', role: 'assistant', finished: false, items: [] },
    session: {
      id: 'native',
      capabilities: { models: [], modes: [] },
      interactionCapabilities: { questions: true, steer: true },
      prompt: async () => assert.fail('Interactions cannot start a prompt'),
      cancel: async () => {},
      close: () => {},
      steer: async () => {
        calls++;
        return driver();
      },
    },
  };
  journal.db
    .prepare('INSERT INTO synthetic_document VALUES(?,?)')
    .run(scope.sessionId, JSON.stringify(run.turn));
  const queue = new Map<string, Promise<unknown>>();
  const serial = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = queue.get(id) ?? Promise.resolve(),
      pending = previous.catch(() => {}).then(work);
    queue.set(id, pending);
    try {
      return await pending;
    } finally {
      if (queue.get(id) === pending) queue.delete(id);
    }
  };
  const dependencies = {
    journal,
    getRun: () => run,
    scopeCheck: (input: typeof scope, localProjectId?: string) => {
      if (
        input.workspaceId !== scope.workspaceId ||
        input.localProjectId !== scope.localProjectId ||
        input.sessionId !== scope.sessionId ||
        (localProjectId && localProjectId !== scope.localProjectId)
      )
        throw new AppError(404, 'Scope not authorized');
      return owner;
    },
    serial,
    persist: (
      id: string,
      target: Run | undefined,
      edit: ((turn: InteractionTurn) => void) | undefined,
      write?: () => void,
    ) => {
      const before = target ? structuredClone(target.turn) : undefined;
      journal.db.exec('BEGIN IMMEDIATE');
      try {
        if (target && edit) {
          edit(target.turn);
          journal.db
            .prepare('INSERT OR REPLACE INTO synthetic_document VALUES(?,?)')
            .run(id, JSON.stringify(target.turn));
        }
        write?.();
        journal.db.exec('COMMIT');
      } catch (error) {
        journal.db.exec('ROLLBACK');
        if (target) target.turn = before!;
        throw error;
      }
    },
  };
  const interactions = new SessionInteractions(dependencies);
  const read = () =>
    JSON.parse(
      journal.db
        .prepare('SELECT body FROM synthetic_document WHERE session_id=?')
        .get(scope.sessionId)!.body as string,
    ) as InteractionTurn;
  const receive = () => {
    const pending = interactions.receiveQuestion(question);
    void pending.catch(() => {});
    return pending;
  };
  return {
    journal,
    interactions,
    dependencies,
    read,
    receive,
    serial,
    get run() {
      return run;
    },
    set run(value) {
      run = value;
    },
    set owner(value: InteractionOwner) {
      owner = value;
    },
    get owner() {
      return owner;
    },
    calls: () => calls,
    setDriver(value: () => Promise<AgentSteerResult>) {
      driver = value;
    },
  };
}
const rejection = (rejected: boolean, status?: number) => (error: unknown) =>
  error instanceof AppError &&
  error.rejected === rejected &&
  (status === undefined || error.status === status);

test('question outcome and receipt commit together and concurrent original-operation retries resolve once', async (t) => {
  const f = fixture(t);
  let resolved = 0;
  const native = f.receive().then((answer) => {
    resolved++;
    return answer;
  });
  await f.serial(scope.sessionId, async () => {});
  assert.equal(f.read().items![0].status, 'pending');
  const receipts = await Promise.all([
    f.interactions.answerQuestion(answer(), scope.localProjectId),
    f.interactions.answerQuestion(answer(), scope.localProjectId),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[0].delivered, true);
  assert.deepEqual((await native).answer, answer().answer);
  assert.equal(resolved, 1);
  assert.equal(f.read().items![0].status, 'answered');
  assert.equal(
    f.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get('answer-op')!.phase,
    'accepted',
  );
  f.run = undefined;
  assert.deepEqual(await f.interactions.answerQuestion(answer()), receipts[0]);
  await assert.rejects(f.interactions.answerQuestion(answer('different-op')), rejection(true, 409));
});

test('semantic invalidity, exact scope and stale request checks never consume an answer operation', async (t) => {
  const f = fixture(t),
    native = f.receive();
  await f.serial(scope.sessionId, async () => {});
  for (const changes of [
    { answer: { action: 'accept', values: { choice: 'unknown' } } },
    { answer: { action: 'accept', values: {} } },
    { expectedTurnId: 'other-turn' },
    { requestId: 'other-question' },
    { localProjectId: 'other-project' },
  ]) {
    await assert.rejects(
      f.interactions.answerQuestion({ ...answer(), ...changes } as QuestionAnswer),
      rejection(true),
    );
    assert.equal(f.journal.has('answer-op'), false);
    assert.equal(f.read().items![0].status, 'pending');
  }
  await f.interactions.answerQuestion(answer());
  await native;
  await assert.rejects(
    f.interactions.answerQuestion({ ...answer(), answer: { action: 'decline' } }),
    rejection(false, 409),
  );
});

test('question receipt collision with another operation kind is global and never resolves the request', async (t) => {
  const f = fixture(t),
    native = f.receive();
  await f.serial(scope.sessionId, async () => {});
  f.journal.acceptSessionAction(
    scope.workspaceId,
    { ...scope, operationId: 'answer-op', action: 'pin', expectedRevision: 0 },
    { id: scope.sessionId },
  );
  await assert.rejects(f.interactions.answerQuestion(answer()), rejection(false, 409));
  assert.equal(f.read().items![0].status, 'pending');
  f.interactions.cancelPending(scope.sessionId, f.run!);
  assert.equal((await native).answer.action, 'cancel');
});

test('SQLite answer failure rolls the document back and leaves the same operation safe to submit', async (t) => {
  const f = fixture(t),
    native = f.receive();
  await f.serial(scope.sessionId, async () => {});
  f.journal.db.exec(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  );
  await assert.rejects(f.interactions.answerQuestion(answer()), rejection(true, 502));
  assert.equal(f.journal.has('answer-op'), false);
  assert.equal(f.read().items![0].status, 'pending');
  assert.equal(f.run!.turn.items![0].status, 'pending');
  f.journal.db.exec('DROP TRIGGER synthetic_failure');
  await f.interactions.answerQuestion(answer());
  assert.equal((await native).answer.action, 'accept');
});

test('stopping and restarting expire questions; delayed answer cannot enter a replacement turn', async (t) => {
  const f = fixture(t),
    native = f.receive();
  await f.serial(scope.sessionId, async () => {});
  const original = f.run!;
  original.stopped = true;
  assert.equal(f.interactions.cancelPending(scope.sessionId, original).persisted, true);
  assert.equal((await native).answer.action, 'cancel');
  assert.equal(f.read().items![0].status, 'cancelled');
  f.run = {
    ...original,
    turnId: 'new-turn',
    stopped: false,
    turn: { id: 'new-turn', role: 'assistant', finished: false, items: [] },
  };
  await assert.rejects(f.interactions.answerQuestion(answer()), rejection(true, 409));
  assert.deepEqual(f.run.turn.items, []);
  const interrupted: InteractionTurn = {
    id: 'turn',
    role: 'assistant',
    items: [
      { type: 'question', status: 'pending', request: question },
      { type: 'steer', status: 'pending', operationId: 'old-steer' },
    ],
  };
  assert.equal(expireSessionInteractions(interrupted), true);
  assert.deepEqual(
    interrupted.items!.map((item) => item.status),
    ['expired', 'unknown'],
  );
  assert.equal(expireSessionInteractions(interrupted), false);
  assert.equal(f.calls(), 0);
});

test('waiting to acquire the session lock revalidates ownership before accepting an answer', async (t) => {
  const f = fixture(t),
    native = f.receive();
  await f.serial(scope.sessionId, async () => {});
  const held = signal<void>(),
    entered = signal<void>();
  const blocker = f.serial(scope.sessionId, async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const pending = f.interactions.answerQuestion(answer());
  void pending.catch(() => {});
  f.owner = { ...f.owner, userId: 'different-owner' };
  held.resolve();
  await blocker;
  await assert.rejects(pending, rejection(true, 409));
  assert.equal(f.journal.has('answer-op'), false);
  assert.equal(f.interactions.cancelPending(scope.sessionId, f.run!).persisted, false);
  assert.equal((await native).answer.action, 'cancel');
});

test('steer stages durably before its single driver call and accepted receipts survive response loss', async (t) => {
  const f = fixture(t),
    entered = signal<void>(),
    outcome = signal<AgentSteerResult>();
  f.setDriver(async () => {
    assert.equal(
      f.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get('steer-op')!.phase,
      'steer-staged',
    );
    assert.equal(f.read().items![0].status, 'pending');
    entered.resolve();
    return outcome.promise;
  });
  const pending = f.interactions.steer(steer());
  await entered.promise;
  await assert.rejects(f.interactions.steer(steer()), rejection(false, 504));
  assert.equal(f.calls(), 1);
  await assert.rejects(
    f.interactions.steer({ ...steer(), prompt: 'Changed body' }),
    rejection(false, 409),
  );
  outcome.resolve({ outcome: 'injected' });
  const receipt = await pending;
  assert.equal(receipt.activityBound, true);
  assert.equal(f.read().items![0].status, 'delivered');
  f.run = undefined;
  assert.deepEqual(await f.interactions.steer(steer()), receipt);
  assert.equal(f.calls(), 1);
});

test('unknown steer delivery cannot be retried at the driver, including through a recreated controller', async (t) => {
  const f = fixture(t);
  f.setDriver(async () => {
    throw new Error('Synthetic lost native response');
  });
  await assert.rejects(f.interactions.steer(steer()), rejection(false, 504));
  assert.equal(f.read().items![0].status, 'unknown');
  await assert.rejects(f.interactions.steer(steer()), rejection(false, 504));
  const restarted = new SessionInteractions(f.dependencies);
  await assert.rejects(restarted.steer(steer()), rejection(false, 504));
  assert.equal(f.calls(), 1);
  await assert.rejects(f.interactions.steer(steer('second-steer')), rejection(true, 409));
});

test('promptRequired is a durable not-injected result and never becomes an automatic new prompt', async (t) => {
  const f = fixture(t);
  f.setDriver(async () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }));
  await assert.rejects(f.interactions.steer(steer()), rejection(false, 409));
  assert.equal(f.read().items![0].status, 'not-injected');
  await assert.rejects(f.interactions.steer(steer()), rejection(false, 409));
  assert.equal(f.calls(), 1);
});

test('steer staging failure invokes no driver and rolls back both document and operation', async (t) => {
  const f = fixture(t);
  f.journal.db.exec(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT,'synthetic stage failure'); END",
  );
  await assert.rejects(f.interactions.steer(steer()), rejection(true, 502));
  assert.equal(f.calls(), 0);
  assert.equal(f.journal.has('steer-op'), false);
  assert.deepEqual(f.read().items, []);
});

test('steer stop races do not block cancellation and late receipts never edit a new turn', async (t) => {
  const f = fixture(t),
    entered = signal<void>(),
    outcome = signal<AgentSteerResult>();
  f.setDriver(async () => {
    entered.resolve();
    return outcome.promise;
  });
  const pending = f.interactions.steer(steer());
  await entered.promise;
  const original = f.run!;
  await f.serial(scope.sessionId, async () => {
    original.stopped = true;
    f.interactions.cancelPending(scope.sessionId, original);
  });
  assert.equal(f.read().items![0].status, 'unknown');
  f.run = {
    ...original,
    turnId: 'new-turn',
    stopped: false,
    turn: { id: 'new-turn', role: 'assistant', items: [] },
  };
  outcome.resolve({ outcome: 'injected' });
  assert.equal((await pending).delivered, true);
  assert.deepEqual(f.run.turn.items, []);
  assert.equal(f.read().items![0].status, 'unknown');
  assert.equal(
    f.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get('steer-op')!.phase,
    'accepted',
  );
});

test('ownership changes and post-injection disk failure leave staged operations unknown without replay', async (t) => {
  for (const change of ['owner', 'disk'] as const)
    await t.test(change, async (t) => {
      const f = fixture(t),
        entered = signal<void>(),
        outcome = signal<AgentSteerResult>();
      f.setDriver(async () => {
        entered.resolve();
        return outcome.promise;
      });
      const pending = f.interactions.steer(steer());
      await entered.promise;
      const owner = f.owner;
      if (change === 'owner') f.owner = { ...owner, rootPath: '/synthetic/replaced' };
      else
        f.journal.db.exec(
          "CREATE TRIGGER synthetic_failure BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
        );
      outcome.resolve({ outcome: 'injected' });
      await assert.rejects(pending, rejection(false));
      assert.equal(
        f.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get('steer-op')!.phase,
        'steer-staged',
      );
      f.owner = owner;
      await assert.rejects(f.interactions.steer(steer()), rejection(false, 504));
      assert.equal(f.calls(), 1);
      assert.equal(f.read().items![0].status, 'pending');
    });
});
