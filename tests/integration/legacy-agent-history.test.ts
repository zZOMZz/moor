import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  accountRateLimitSchema,
  normalizeSessionEvent,
  sessionEventSchema,
} from '@moor/host/sessions/events';
import {
  informationHtml,
  sessionInformation,
} from '../../apps/web/src/features/interactions/interactions';
import {
  agentForkAnchorSchema,
  codexAgentForkAnchorSchema,
  ForkAnchorObservation,
  pinnedForkAdapter,
  validateForkInput,
  type AgentForkAnchor,
} from '@moor/host/agents/fork';
import { RuntimeStore } from '@moor/host/persistence/store';
import type { AgentConfig } from '@moor/host/agents/driver';

const legacyRateLimit = {
  source: 'claude-agent-acp' as const,
  adapterVersion: '0.76.0' as const,
  status: 'rejected' as const,
  rateLimitType: 'seven_day' as const,
  resetsAt: 1,
  overageStatus: 'rejected' as const,
  overageDisabledReason: 'out_of_credits' as const,
};

test('persisted Claude account-limit events remain typed and visible but cannot be generated now', () => {
  accountRateLimitSchema.parse(legacyRateLimit);
  const persisted = sessionEventSchema.parse({
    version: 1,
    source: 'acp',
    kind: 'account-rate-limit',
    rateLimit: legacyRateLimit,
  });
  assert.equal(
    sessionEventSchema.safeParse({
      ...persisted,
      rateLimit: { ...legacyRateLimit, credential: 'synthetic-secret' },
    }).success,
    false,
  );
  const state = sessionInformation([{ type: 'session_event', event: persisted }]);
  assert.deepEqual(state.rateLimits, [legacyRateLimit]);
  const dom = new JSDOM(informationHtml(state));
  try {
    assert.match(dom.window.document.body.textContent!, /历史账号额度/);
    assert.match(dom.window.document.body.textContent!, /Claude ACP 0\.76\.0/);
    assert.match(dom.window.document.body.textContent!, /7 天.*已受限/s);
    assert.match(dom.window.document.body.textContent!, /额度已耗尽/);
    assert.match(dom.window.document.body.textContent!, /旧会话的只读兼容数据/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /synthetic-secret/);
  } finally {
    dom.window.close();
  }

  const current = normalizeSessionEvent({
    sessionUpdate: 'usage_update',
    used: 10,
    size: 100,
    _meta: { '_claude/rateLimit': legacyRateLimit },
  });
  assert.deepEqual(current, {
    status: 'accepted',
    event: { version: 1, source: 'acp', kind: 'context-usage', used: 10, size: 100 },
  });
});

test('persisted Claude fork anchors remain readable but cannot be saved or executed', (t) => {
  const store = new RuntimeStore(':memory:');
  t.after(() => store.close());
  const scope = {
      workspaceId: 'workspace',
      userId: 'local:synthetic',
      machineId: 'machine',
      localProjectId: 'project',
      sessionId: 'session',
    },
    execution = {
      ...scope,
      rootPath: '/synthetic/project',
      projectRoot: '/synthetic/project',
      executionId: 'shared',
      executionRevision: 0,
    },
    codex: AgentConfig = {
      id: 'codex',
      name: 'Codex',
      cliType: 'builtin',
      agentType: 'codex',
      machineId: scope.machineId,
      runtimeOverrides: { codexPath: process.execPath },
    },
    legacyAgent: AgentConfig = {
      ...codex,
      id: 'legacy-claude',
      name: 'Legacy Claude',
      agentType: 'claude',
      runtimeOverrides: undefined,
    },
    legacyAnchor: AgentForkAnchor = {
      version: 1,
      kind: 'completed-turn',
      adapter: 'claude-agent-acp',
      adapterVersion: '0.76.0',
      sourceNativeId: 'legacy-native',
      messageId: 'legacy-message',
    },
    codexAnchor = codexAgentForkAnchorSchema.parse({
      ...legacyAnchor,
      adapter: 'codex-acp',
      adapterVersion: '1.11.0',
    });

  assert.deepEqual(agentForkAnchorSchema.parse(legacyAnchor), legacyAnchor);
  assert.equal(codexAgentForkAnchorSchema.safeParse(legacyAnchor).success, false);
  store.forks.saveAnchor(scope, execution, 'turn', codexAnchor, legacyAgent);
  store.journal.db
    .prepare('UPDATE session_fork_anchor SET anchor=? WHERE turn_id=?')
    .run(JSON.stringify(legacyAnchor), 'turn');
  assert.deepEqual(
    store.forks.anchor(scope, execution, legacyAnchor.sourceNativeId, 'turn', legacyAgent),
    legacyAnchor,
  );
  assert.throws(() =>
    store.forks.saveAnchor(scope, execution, 'new-turn', legacyAnchor, legacyAgent),
  );
  assert.equal(pinnedForkAdapter(legacyAgent), undefined);
  assert.throws(() =>
    validateForkInput(legacyAgent, {
      sourceNativeId: legacyAnchor.sourceNativeId,
      sourceCwd: '/synthetic/source',
      targetCwd: '/synthetic/target',
      anchor: legacyAnchor,
    }),
  );
  const observation = new ForkAnchorObservation();
  observation.observe({ sessionUpdate: 'agent_message_chunk', messageId: 'new-message' });
  assert.equal(observation.complete(legacyAgent, legacyAnchor.sourceNativeId), undefined);
});
