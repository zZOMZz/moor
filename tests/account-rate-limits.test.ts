import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  applySessionEvent,
  normalizePromptUsage,
  normalizeSessionEvent,
  sessionEventSchema,
  sessionEventStateSchema,
  type SessionEventSource,
} from '../src/runtime/session-events';
import { informationHtml, sessionInformation } from '../src/web/interactions';

const source: SessionEventSource = {
  agentType: 'claude',
  custom: false,
  agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.76.0' },
};
const usage = (value: unknown) => ({
  sessionUpdate: 'usage_update',
  used: 42,
  size: 1000,
  _meta: { '_claude/rateLimit': value, credentials: 'synthetic-secret' },
});
function event(value: unknown, identity = source) {
  const result = normalizeSessionEvent(usage(value), identity);
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted' || result.event.kind !== 'context-usage')
    throw new Error('Expected context report');
  return result.event;
}

test('account limits require the actual fixed built-in adapter and project only typed limit facts', () => {
  const reported = {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    utilization: 0.8,
    resetsAt: 1893456000,
    overageStatus: 'rejected',
    overageResetsAt: 1893456001,
    overageDisabledReason: 'out_of_credits',
    canUserPurchaseCredits: true,
    hasChargeableSavedPaymentMethod: true,
    email: 'private@synthetic.invalid',
    credentials: 'synthetic-secret',
  };
  assert.deepEqual(event(reported).rateLimit, {
    source: 'claude-agent-acp',
    adapterVersion: '0.76.0',
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    utilization: 0.8,
    resetsAt: 1893456000,
    overageStatus: 'rejected',
    overageResetsAt: 1893456001,
    overageDisabledReason: 'out_of_credits',
  });
  for (const identity of [
    undefined,
    { ...source, custom: true },
    { ...source, agentType: 'codex' },
    { ...source, agentInfo: undefined },
    { ...source, agentInfo: { ...source.agentInfo!, name: 'custom-claude' } },
    { ...source, agentInfo: { ...source.agentInfo!, version: '0.76.1' } },
    { ...source, agentInfo: { ...source.agentInfo!, version: undefined } },
  ]) {
    const result = normalizeSessionEvent(usage(reported), identity);
    assert.equal(result.status, 'accepted');
    assert.doesNotMatch(JSON.stringify(result), /rateLimit|synthetic-secret|private@|Payment/);
  }
  const forged = usage(reported);
  Object.assign(forged._meta, { agentInfo: source.agentInfo, agentType: 'claude' });
  assert.doesNotMatch(JSON.stringify(normalizeSessionEvent(forged)), /rateLimit|secret/);
});

test('invalid limit extensions cannot erase valid context or leak diagnostics into shared state', () => {
  for (const invalid of [
    undefined,
    null,
    { status: 'unknown' },
    { status: 'allowed', utilization: -1 },
    { status: 'allowed', utilization: 1.01 },
    { status: 'allowed', utilization: Infinity },
    { status: 'allowed', utilization: null },
    { status: 'allowed', resetsAt: -1 },
    { status: 'allowed', resetsAt: 1893456000000 },
    { status: 'allowed', rateLimitType: '<script>unsafe()</script>' },
    { status: 'allowed', overageStatus: 'synthetic-secret' },
    { status: 'allowed', overageDisabledReason: 'private diagnostic' },
  ]) {
    const value = event(invalid);
    assert.equal(value.used, 42);
    assert.equal(value.size, 1000);
    assert.equal(value.rateLimit, undefined);
  }
  const accepted = event({ status: 'allowed', utilization: 1, resetsAt: 0 });
  assert.equal(accepted.rateLimit?.utilization, 1);
  assert.equal(accepted.rateLimit?.resetsAt, 0);
  assert.equal(
    sessionEventSchema.safeParse({
      ...accepted,
      rateLimit: { ...accepted.rateLimit, credentials: 'synthetic-secret' },
    }).success,
    false,
  );
  const tokenOnly = normalizePromptUsage({
    stopReason: 'end_turn',
    usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
    _meta: { quota: { token_count: 3, model_usage: [{ model: 'synthetic', token_count: 3 }] } },
  });
  assert.doesNotMatch(JSON.stringify(tokenOnly), /quota|rateLimit|model_usage/);
});

test('last reported windows stay separate and a sparse update never inherits zero or old utilization', () => {
  const zero = event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0 });
  const weekly = event({
    status: 'rejected',
    rateLimitType: 'seven_day',
    utilization: 1,
    resetsAt: 1,
  });
  const prior = applySessionEvent(applySessionEvent(undefined, zero), weekly);
  const sparse = event({ status: 'allowed_warning', rateLimitType: 'five_hour' });
  const next = applySessionEvent(prior, sparse);
  assert.equal(prior.rateLimits?.[0]?.utilization, 0);
  assert.equal(
    next.rateLimits?.find((row) => row.rateLimitType === 'five_hour')?.utilization,
    undefined,
  );
  assert.equal(
    next.rateLimits?.find((row) => row.rateLimitType === 'seven_day')?.status,
    'rejected',
  );
  assert.equal(next.rateLimits?.length, 2);
  const ordinary = normalizeSessionEvent({ sessionUpdate: 'usage_update', used: 90, size: 1000 });
  if (ordinary.status !== 'accepted') throw new Error('Expected context update');
  const preserved = applySessionEvent(next, ordinary.event);
  assert.deepEqual(preserved.rateLimits, next.rateLimits);
  assert.equal(preserved.contextUsage?.used, 90);
  sessionEventStateSchema.parse(preserved);
  const replayed = sessionInformation(
    [zero, weekly, sparse, ordinary.event].map((value) => ({
      type: 'session_event',
      event: value,
    })),
  );
  assert.deepEqual(replayed, preserved);
});

test('visible account limits distinguish missing and zero, preserve rejected history after reset and expose no raw payload', () => {
  const zero = event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0 });
  const expired = event({
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: 1,
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    email: 'synthetic-secret',
  });
  const state = applySessionEvent(applySessionEvent(undefined, zero), expired);
  const dom = new JSDOM(informationHtml(state));
  try {
    const sections = [...dom.window.document.querySelectorAll('.agent-rate-limit')];
    assert.equal(sections.length, 2);
    assert.match(sections[0]!.textContent!, /5 小时.*已用比例0%/s);
    assert.match(sections[1]!.textContent!, /7 天.*上报状态已受限.*已用比例未提供/s);
    assert.match(sections[1]!.textContent!, /1970-01-01T00:00:01.000Z/);
    assert.match(sections[1]!.textContent!, /额度已耗尽/);
    assert.match(dom.window.document.body.textContent!, /不会推断额度已恢复/);
    assert.match(dom.window.document.body.textContent!, /离线时仅显示已读历史/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /synthetic-secret|付款/);
    assert.match(informationHtml({ version: 1, plans: [] }), /Agent 未提供可验证的账号额度报告/);
  } finally {
    dom.window.close();
  }
});
