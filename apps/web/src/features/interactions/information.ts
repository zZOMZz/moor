import type { AccountRateLimit, SessionEventState } from '@moor/protocol/session-events';
import { esc, markdown } from '../../components/content';
const count = (value: number | undefined) =>
  value === undefined ? '未提供' : esc(value.toLocaleString());
const legacyRateLimitStatuses = {
  allowed: '可用',
  allowed_warning: '接近限额',
  rejected: '已受限',
};
const legacyRateLimitWindows = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet',
  seven_day_overage_included: '7 天 · 包含的额外用量',
  overage: '额外用量',
};
const legacyOverageReasons = {
  overage_not_provisioned: '未开通额外用量',
  org_level_disabled: '组织已停用',
  org_level_disabled_until: '组织暂时停用',
  out_of_credits: '额度已耗尽',
  seat_tier_level_disabled: '席位等级不支持',
  member_level_disabled: '成员已停用',
  seat_tier_zero_credit_limit: '席位额度上限为零',
  group_zero_credit_limit: '组额度上限为零',
  member_zero_credit_limit: '成员额度上限为零',
  org_service_level_disabled: '组织服务已停用',
  no_limits_configured: '未配置额度',
  fetch_error: 'Agent 当时未能读取额外用量',
  unknown: 'Agent 未提供具体原因',
};
const legacyResetTime = (seconds: number | undefined) =>
  seconds === undefined ? '未提供' : esc(new Date(seconds * 1000).toISOString());
function legacyRateLimitHtml(value: AccountRateLimit) {
  const overage =
    value.overageStatus !== undefined ||
    value.overageResetsAt !== undefined ||
    value.overageDisabledReason !== undefined;
  return `<section class="agent-rate-limit"><h4>${value.rateLimitType ? legacyRateLimitWindows[value.rateLimitType] : '窗口未提供'}</h4><p class="muted">历史来源：Claude ACP ${esc(value.adapterVersion)} · 仅展示已保存记录</p><dl class="agent-usage"><dt>上报状态</dt><dd>${legacyRateLimitStatuses[value.status]}</dd><dt>已用比例</dt><dd>${value.utilization === undefined ? '未提供' : `${esc((value.utilization * 100).toLocaleString(undefined, { maximumSignificantDigits: 15 }))}%`}</dd><dt>窗口重置时间（UTC）</dt><dd>${legacyResetTime(value.resetsAt)}</dd>${overage ? `<dt>额外用量状态</dt><dd>${value.overageStatus ? legacyRateLimitStatuses[value.overageStatus] : '未提供'}</dd><dt>额外用量重置时间（UTC）</dt><dd>${legacyResetTime(value.overageResetsAt)}</dd><dt>额外用量不可用原因</dt><dd>${value.overageDisabledReason ? legacyOverageReasons[value.overageDisabledReason] : '未提供'}</dd>` : ''}</dl></section>`;
}
export function informationHtml(state: SessionEventState) {
  const context = state.contextUsage,
    tokens = state.tokenUsage,
    legacyRateLimits = state.rateLimits?.map(legacyRateLimitHtml).join('') ?? '';
  const plans = state.plans
    .map(
      (plan) =>
        `<section class="agent-plan">${plan.planId ? `<h4>${esc(plan.planId)}</h4>` : ''}${plan.content.format === 'markdown' ? markdown(plan.content.text) : plan.content.format === 'file' ? `<p>文件计划引用：<code>${esc(plan.content.uri)}</code></p><p class="muted">引用尚未解析；不会自动读取或访问该地址。</p>` : `<ol>${plan.content.entries.map((entry) => `<li><span class="plan-status">${esc({ pending: '待处理', in_progress: '进行中', completed: '已完成' }[entry.status])} · ${esc({ high: '高', medium: '中', low: '低' }[entry.priority])}优先级</span><span>${esc(entry.content)}</span></li>`).join('')}</ol>`}</section>`,
    )
    .join('');
  return `<section class="agent-information"><p class="muted">来源：Agent 通过 ACP 上报。以下是最近一次原始计数；不会跨回合相加。</p><h3>计划</h3>${plans || `<p>${state.planObserved ? '当前没有计划条目' : '未提供计划'}</p>`}<h3>用量</h3><dl class="agent-usage"><dt>上下文已用 / 容量</dt><dd>${count(context?.used)} / ${count(context?.size)}</dd><dt>费用</dt><dd>${context?.cost ? `${esc(context.cost.amount)} ${esc(context.cost.currency)}` : '未提供'}</dd>${(
    [
      ['总 token', tokens?.totalTokens],
      ['输入 token', tokens?.inputTokens],
      ['输出 token', tokens?.outputTokens],
      ['思考 token', tokens?.thoughtTokens],
      ['缓存读取 token', tokens?.cachedReadTokens],
      ['缓存写入 token', tokens?.cachedWriteTokens],
    ] as const
  )
    .map(([label, value]) => `<dt>${label}</dt><dd>${count(value)}</dd>`)
    .join(
      '',
    )}</dl><p class="muted">token 范围由 Agent 报告，未推断为本回合增量；费用仅显示上报币种与金额。</p>${legacyRateLimits ? `<h3>历史账号额度</h3>${legacyRateLimits}<p class="muted">这是旧会话的只读兼容数据，不代表当前实时余额；Moor 不再从 Agent 生成此类报告。</p>` : ''}</section>`;
}
