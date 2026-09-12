import test from 'node:test';
import assert from 'node:assert/strict';
import { Flock, LoroDoc, delta, metas, putMeta } from '../src/model';
import { sessionReadResponseSchema, validateSessionBundle } from '../src/session-responses';
import { sessionActionSchema } from '../src/protocol';

function forkResponse(directory: 'same-directory' | 'worktree') {
  const meta = new Flock();
  putMeta(meta, 'session-child', {
    id: 'child',
    userId: 'synthetic',
    machineId: 'machine',
    agentConfigId: 'agent',
    cliType: 'builtin',
    agentType: 'codex',
    project: { kind: 'local', localProjectId: 'project' },
    title: 'x'.repeat(200) + ' · Fork',
    forkOrigin: {
      version: 1,
      sourceSessionId: 'source',
      sourceVersion: 'sha256:' + 'a'.repeat(64),
      sourceTitle: 'x'.repeat(200),
      cutoff: { kind: 'turn', turnId: 'old-assistant' },
      directory,
      ...(directory === 'worktree' ? { branch: 'moor/fork', baseOid: 'b'.repeat(40) } : {}),
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  return {
    meta: metas(meta)['session-child'],
    metaBundle: meta.exportJson(),
    update: delta(new LoroDoc()),
    synced: true,
    online: true,
    persisted: true,
  };
}

for (const directory of ['same-directory', 'worktree'] as const)
  test(`real Flock ${directory} Fork metadata remains readable with canonical object key ordering and old suffixed titles`, () => {
    const raw = forkResponse(directory);
    const parsed = sessionReadResponseSchema.parse(raw);
    assert.equal(parsed.meta.title!.length, 207);
    assert.doesNotThrow(() => validateSessionBundle(parsed));
    // Projection must keep the original clocks and object data; key order has no
    // semantic meaning but changing Flock data under an old clock would.
    assert.deepEqual(parsed.metaBundle, raw.metaBundle);
    assert.deepEqual(
      metas(Flock.fromJson(parsed.metaBundle, 'synthetic-reader'))['session-child'],
      raw.meta,
    );
  });

test('Flock projection still rejects hidden properties and mismatching object identity', () => {
  const raw = forkResponse('worktree');
  const entry = raw.metaBundle.entries['["m","session-child","project"]']!;
  for (const project of [
    { kind: 'local', localProjectId: 'project', rootPath: '/private' },
    { kind: 'local', localProjectId: 'other-project' },
  ]) {
    entry.d = JSON.parse(JSON.stringify(project));
    assert.throws(() => validateSessionBundle(sessionReadResponseSchema.parse(raw)));
  }
  assert.equal(
    sessionActionSchema.safeParse({
      operationId: 'rename',
      workspaceId: 'workspace',
      sessionId: 'child',
      localProjectId: 'project',
      expectedRevision: 0,
      action: 'rename',
      title: 'x'.repeat(201),
    }).success,
    false,
  );
});
