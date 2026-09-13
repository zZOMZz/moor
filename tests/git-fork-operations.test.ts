import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gitActionSchema,
  gitOperationSchema,
  gitRequestVersion,
  validateGitActionReceipt,
  validateGitOperationResult,
} from '../src/git-protocol';
import {
  sessionForkSchema,
  forkOperationSchema,
  forkRequestVersion,
  validateForkActionReceipt,
  validateForkOperationResult,
} from '../src/fork-protocol';

const scope = { workspaceId: 'workspace', localProjectId: 'project', sessionId: 'session' };
const oid = 'a'.repeat(40),
  version = 'sha256:' + 'b'.repeat(64);
const git = gitActionSchema.parse({
  ...scope,
  gitVersion: 1,
  operationId: 'git-op',
  action: 'prepare',
  expectedRevision: 0,
  baseBranch: 'main',
  expectedOid: oid,
  newBranch: 'synthetic-branch',
});
const fork = sessionForkSchema.parse({
  ...scope,
  forkVersion: 1,
  operationId: 'fork-op',
  childSessionId: 'child',
  expectedSourceVersion: version,
  expectedExecutionRevision: 0,
  cutoff: { kind: 'turn', turnId: 'original-turn' },
  directory: {
    kind: 'worktree',
    baseBranch: 'main',
    expectedOid: oid,
    newBranch: 'synthetic-branch',
  },
});
const execution = {
  mode: 'worktree',
  status: 'ready',
  revision: 1,
  executionId: 'execution',
  branch: 'synthetic-branch',
  baseOid: oid,
} as const;
const gitReceipt = {
  ...scope,
  gitVersion: 1,
  operationId: git.operationId,
  phase: 'accepted',
  confirmed: true,
  execution,
};
const forkReceipt = {
  ...scope,
  forkVersion: 1,
  operationId: fork.operationId,
  childSessionId: fork.childSessionId,
  phase: 'accepted',
  confirmed: true,
  execution,
  origin: {
    version: 1,
    sourceSessionId: fork.sessionId,
    sourceVersion: version,
    sourceTitle: 'Synthetic',
    cutoff: fork.cutoff,
    directory: 'worktree',
    branch: 'synthetic-branch',
    baseOid: oid,
    createdAt: '2026-09-13T00:00:00.000Z',
  },
};

test('Git and Fork recovery schemas require the complete strict original body and never admit retry execution', () => {
  for (const [schema, request] of [
    [gitOperationSchema, git],
    [forkOperationSchema, fork],
  ] as const) {
    assert.deepEqual(schema.parse({ action: 'inspect', request }), { action: 'inspect', request });
    for (const invalid of [
      { action: 'retry', request },
      { action: 'abandon', operationId: request.operationId },
      { action: 'inspect', request, target: 'foreign' },
      { action: 'inspect', request: { ...request, owner: 'foreign' } },
      { action: 'inspect', request: { ...request, localProjectId: undefined } },
    ])
      assert.equal(schema.safeParse(invalid).success, false);
  }
});

test('recovery validates original action, scope, operation id, body hash and full nested receipt', async () => {
  for (const item of [
    {
      request: git,
      receipt: gitReceipt,
      version: { gitVersion: 1 },
      hash: gitRequestVersion,
      validate: validateGitOperationResult,
    },
    {
      request: fork,
      receipt: forkReceipt,
      version: { forkVersion: 1 },
      hash: forkRequestVersion,
      validate: validateForkOperationResult,
    },
  ]) {
    const request = item.request as any;
    const result = {
      ...scope,
      ...item.version,
      operationId: request.operationId,
      action: 'inspect',
      confirmed: true,
      found: true,
      requestVersion: await item.hash(request),
      receipt: item.receipt,
    };
    const validate = item.validate as (value: unknown, input: any) => Promise<unknown>;
    assert.deepEqual(await validate(result, { action: 'inspect', request }), result);
    for (const field of [
      'workspaceId',
      'localProjectId',
      'sessionId',
      'operationId',
      'requestVersion',
    ]) {
      const foreign = field === 'requestVersion' ? 'sha256:' + 'c'.repeat(64) : 'foreign';
      await assert.rejects(
        validate({ ...result, [field]: foreign }, { action: 'inspect', request }),
      );
      if (field !== 'requestVersion')
        await assert.rejects(
          validate(
            { ...result, receipt: { ...item.receipt, [field]: foreign } },
            { action: 'inspect', request },
          ),
        );
    }
    await assert.rejects(
      validate({ ...result, action: 'abandon' }, { action: 'inspect', request }),
    );
    const { receipt: _receipt, ...absent } = result;
    assert.deepEqual(await validate({ ...absent, found: false }, { action: 'inspect', request }), {
      ...absent,
      found: false,
    });
    await assert.rejects(
      validate({ ...absent, action: 'abandon', found: false }, { action: 'abandon', request }),
    );
    const changed =
      'gitVersion' in request
        ? { ...request, newBranch: 'changed' }
        : { ...request, cutoff: { kind: 'current' } };
    await assert.rejects(validate(result, { action: 'inspect', request: changed }));
  }
});

test('accepted results bind exact Git state and Fork child, cutoff, source version and execution', () => {
  assert.deepEqual(validateGitActionReceipt(gitReceipt, git), gitReceipt);
  for (const changed of [
    { revision: 2 },
    { branch: 'foreign' },
    { baseOid: 'c'.repeat(40) },
    { status: 'removed' },
  ])
    assert.throws(() =>
      validateGitActionReceipt({ ...gitReceipt, execution: { ...execution, ...changed } }, git),
    );
  assert.deepEqual(validateForkActionReceipt(forkReceipt, fork), forkReceipt);
  assert.throws(() =>
    validateForkActionReceipt({ ...forkReceipt, childSessionId: 'foreign' }, fork),
  );
  for (const changed of [
    { sourceVersion: 'sha256:' + 'c'.repeat(64) },
    { cutoff: { kind: 'current' } },
    { directory: 'same-directory' },
    { branch: 'foreign' },
  ])
    assert.throws(() =>
      validateForkActionReceipt(
        { ...forkReceipt, origin: { ...forkReceipt.origin, ...changed } },
        fork,
      ),
    );
  assert.throws(() =>
    validateForkActionReceipt({ ...forkReceipt, execution: { ...execution, revision: 2 } }, fork),
  );
});

test('abandoned Fork is unconfirmed and retains the exact created worktree for explicit resource cleanup', async () => {
  const receipt = { ...forkReceipt, phase: 'abandoned', confirmed: false };
  const result = {
    ...scope,
    forkVersion: 1,
    operationId: fork.operationId,
    action: 'abandon',
    confirmed: true,
    found: true,
    requestVersion: await forkRequestVersion(fork),
    receipt,
  };
  assert.deepEqual(
    await validateForkOperationResult(JSON.parse(JSON.stringify(result)), {
      action: 'abandon',
      request: fork,
    }),
    result,
  );
  for (const phase of ['unknown', 'rejected', 'abandoned']) {
    for (const changed of [{ branch: 'foreign' }, { baseOid: 'c'.repeat(40) }, { revision: 2 }])
      assert.throws(() =>
        validateForkActionReceipt(
          { ...receipt, phase, execution: { ...execution, ...changed } },
          fork,
        ),
      );
  }
  assert.throws(() => validateForkActionReceipt({ ...receipt, confirmed: true }, fork));
  assert.throws(() => validateGitActionReceipt({ ...gitReceipt, phase: 'abandoned' }, git));
});
