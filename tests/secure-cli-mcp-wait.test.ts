import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliState } from '../src/cli/state';
import { EncryptedCliClient } from '../src/cli/encrypted-client';
import { parseCliArgs } from '../src/cli/args';
import { LoroDoc, mirror, encode } from '../src/model';
import type { CliDependencies } from '../src/cli/client';
import type { SecureCliOperation } from '../src/cli/secure-operation';
import type { HostCommand } from '../src/bridge/host-command';

const target = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'workspace',
  localProjectId: 'project',
  userId: 'local-user',
  machineId: 'machine',
  sessionId: 'session',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
function snapshot(finished: boolean, status = 'handled', wrong = false, duplicate = false) {
  const doc = new LoroDoc();
  doc.getMap('session').set('id', 'session');
  const view = mirror(doc, 'session');
  view.setState((state) => {
    const turn = (
      id: string,
      role: 'user' | 'assistant',
      userTurnId: string | undefined,
      done: boolean,
    ) => ({
      id,
      role,
      userTurnId,
      userId: role === 'user' ? 'local-user' : undefined,
      timestamp: '2026-01-01T00:00:00.000Z',
      finished: done,
      status,
      read: undefined,
      inputConfig: role === 'user' ? { mcpServerIds: ['server'] } : undefined,
      fileDiff: null,
      items: [],
    });
    state.history.push(turn(wrong ? 'other-user' : 'original-user', 'user', undefined, true));
    state.history.push(
      turn('original-assistant', 'assistant', wrong ? 'other-user' : 'original-user', finished),
    );
    // A later completed turn must never make the original unfinished turn appear complete.
    state.history.push(turn('latest-user', 'user', undefined, true));
    state.history.push(turn('latest-assistant', 'assistant', 'latest-user', true));
    if (duplicate)
      state.history.push(turn('ambiguous-assistant', 'assistant', 'original-user', true));
  });
  doc.commit();
  const update = encode(doc.export({ mode: 'snapshot' }));
  view.dispose();
  doc.free();
  return {
    meta: {
      id: 'session',
      userId: 'local-user',
      machineId: 'machine',
      project: { kind: 'local', localProjectId: 'project' },
      agentConfigId: 'agent',
      cliType: 'custom',
      agentType: 'synthetic',
      latestUserMsgId: 'latest-user',
    },
    metaBundle: { version: 0, entries: {} },
    update,
    synced: true,
    online: true,
    persisted: true,
  };
}
function fixture(t: TestContext, extra: Partial<CliDependencies> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-mcp-wait-'))),
    state = new CliState(root);
  t.after(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const staged = state.secureStage({
    operationId: 'operation',
    kind: 'turn',
    target,
    userTurnId: 'original-user',
    mcpReview: {
      reviewId: 'review',
      servers: [
        { id: 'server', name: 'Synthetic', description: 'Synthetic tools', transport: 'http' },
      ],
    },
    body: JSON.stringify({
      method: 'mutate',
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        operationId: 'operation',
        kind: 'turn',
        expectedTurnId: null,
        update: 'SYNTHETIC_DELTA',
      },
    }),
  });
  const operation = state.secureTransition(staged.operationId, ['pending'], 'accepted', {
    accepted: true,
    delivered: true,
    operationId: staged.operationId,
  });
  const client = new EncryptedCliClient({
    state,
    stdin: (async function* () {})(),
    ...extra,
  }) as unknown as {
    waitForMcp: (
      transport: unknown,
      op: SecureCliOperation,
      args: unknown,
      current: () => void,
    ) => Promise<any>;
  };
  let closes = 0;
  const transport = {
    close() {
      closes++;
    },
    execute: async (_host: string, command: HostCommand, product: unknown) => {
      assert.equal(command.method, 'session');
      assert.equal(command.params.sessionId, 'session');
      assert.deepEqual(product, target.product);
      return snapshot(true);
    },
  };
  return {
    state,
    operation,
    transport,
    get closes() {
      return closes;
    },
    wait: (flags: Record<string, string> = {}, current = () => {}) =>
      client.waitForMcp(transport, operation, { flags }, current),
  };
}

test('MCP foreground waiting has no default expiry and observes only the original user and assistant turn', async (t) => {
  let reads = 0,
    pauses = 0;
  const f = fixture(t, {
    deadline: () => {
      throw Error('No default deadline');
    },
    pause: async () => {
      pauses++;
    },
  });
  f.transport.execute = async () => snapshot(++reads > 1);
  assert.deepEqual(await f.wait(), {
    userTurnId: 'original-user',
    assistantTurnId: 'original-assistant',
    status: 'handled',
  });
  assert.equal(reads, 2);
  assert.equal(pauses, 1);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.state.secureOperation('operation'), f.operation);
});
for (const fault of [
  'timeout',
  'interrupt',
  'changed',
  'failed',
  'wrong-turn',
  'ambiguous',
  'not-persisted',
] as const)
  test(`MCP waiting ${fault} preserves acceptance, never replays, and closes its exact channel`, async (t) => {
    const ending = new AbortController(),
      interrupted = new AbortController();
    let current = true,
      reads = 0;
    const f = fixture(t, {
      signal: interrupted.signal,
      deadline: (ms) => {
        assert.equal(ms, 50);
        return ending.signal;
      },
      pause: async () => {
        throw Error('Unexpected pause');
      },
    });
    f.transport.execute = async () => {
      reads++;
      if (fault === 'timeout') {
        ending.abort();
        throw Error('Read closed');
      }
      if (fault === 'interrupt') {
        interrupted.abort();
        throw Error('Read closed');
      }
      if (fault === 'changed') current = false;
      return {
        ...snapshot(
          true,
          fault === 'failed' ? 'failed' : 'handled',
          fault === 'wrong-turn',
          fault === 'ambiguous',
        ),
        persisted: fault !== 'not-persisted',
      };
    };
    await assert.rejects(
      f.wait(fault === 'timeout' ? { timeout: '50' } : {}, () => {
        assert.ok(current);
      }),
      (error: any) =>
        error.operationId === 'operation' &&
        error.code ===
          (fault === 'timeout'
            ? 'wait-timeout'
            : fault === 'interrupt'
              ? 'interrupted'
              : fault === 'failed'
                ? 'turn-failed'
                : 'execution-unconfirmed'),
    );
    assert.equal(reads, 1);
    assert.ok(f.closes >= 1);
    assert.deepEqual(f.state.secureOperation('operation'), f.operation);
  });

test('secure MCP send and retry accept explicit bounded foreground timeout without changing legacy wait flags', () => {
  for (const timeout of ['1', '86400000']) {
    assert.equal(
      parseCliArgs([
        'secure',
        'send',
        'session',
        '--endpoint',
        '/private/endpoint',
        '--host',
        'host',
        '--workspace',
        'workspace',
        '--project',
        'project',
        '--stdin',
        '--mcp-server-ids',
        'server',
        '--timeout',
        timeout,
      ]).flags.timeout,
      timeout,
    );
    assert.equal(
      parseCliArgs([
        'secure',
        'retry',
        'operation',
        '--endpoint',
        '/private/endpoint',
        '--timeout',
        timeout,
      ]).flags.timeout,
      timeout,
    );
  }
  for (const timeout of ['0', '86400001', 'nan'])
    assert.throws(() =>
      parseCliArgs([
        'secure',
        'retry',
        'operation',
        '--endpoint',
        '/private/endpoint',
        '--timeout',
        timeout,
      ]),
    );
  assert.throws(() =>
    parseCliArgs(['secure', 'retry', 'operation', '--endpoint', '/private/endpoint', '--wait']),
  );
});
