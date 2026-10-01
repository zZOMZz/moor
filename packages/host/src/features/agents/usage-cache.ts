import {
  agentUsageUpdateSchema,
  projectAccountUsage,
  USAGE_CACHE_MS,
  type AccountUsage,
  type AgentUsageUpdate,
} from '@moor/protocol/agent-usage';

type Entry = {
  account?: string;
  value: AccountUsage;
  revision: number;
  attemptedAt: number;
  pending?: Promise<AccountUsage>;
};
/** Host-local account telemetry. Session bodies never carry this cache. */
export class AgentUsageCache {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}
  peek(key: string): AccountUsage {
    return structuredClone(
      this.entries.get(key)?.value ?? { version: 1, status: 'unknown', buckets: [] },
    );
  }
  update(key: string, raw: AgentUsageUpdate) {
    const update = agentUsageUpdateSchema.parse(raw),
      previous = this.entries.get(key),
      now = this.now();
    // Session startup can confirm identity without fetching quota. Keep the same
    // account's snapshot, but invalidate it immediately when the identity changes.
    if (update.status === 'unknown' && update.accountKey && previous?.account === update.accountKey)
      return this.peek(key);
    let value = projectAccountUsage(update, now);
    if (
      update.partial &&
      previous &&
      previous.account === update.accountKey &&
      ['ready', 'failed'].includes(previous.value.status)
    ) {
      const buckets = [...previous.value.buckets];
      for (const next of value.buckets) {
        const index = buckets.findIndex((b) => b.id === next.id);
        if (index < 0) buckets.push(next);
        else buckets[index] = next;
      }
      value = { ...value, buckets };
    }
    if (update.status === 'failed' && previous && previous.account === update.accountKey)
      value = { ...previous.value, status: 'failed' };
    this.entries.set(key, {
      account: update.accountKey,
      value,
      revision: (previous?.revision ?? 0) + 1,
      attemptedAt: update.status === 'unknown' ? -Infinity : now,
      pending: previous?.pending,
    });
    if (this.entries.size > 500) {
      const stale = [...this.entries].find(([id, entry]) => id !== key && !entry.pending);
      if (stale) this.entries.delete(stale[0]);
    }
    return this.peek(key);
  }
  async read(
    key: string,
    load: () => Promise<AgentUsageUpdate>,
    current: () => void,
    force = false,
  ): Promise<AccountUsage> {
    current();
    let entry = this.entries.get(key);
    if (entry?.pending) {
      const value = await entry.pending;
      current();
      return structuredClone(value);
    }
    if (!force && entry && this.now() - entry.attemptedAt < USAGE_CACHE_MS) return this.peek(key);
    entry ??= {
      value: { version: 1, status: 'unknown', buckets: [] },
      revision: 0,
      attemptedAt: this.now(),
    };
    this.entries.set(key, entry);
    const revision = entry.revision;
    const pending = (async () => {
      try {
        const update = await Promise.resolve().then(load);
        current();
        if (this.entries.get(key)!.revision === revision) this.update(key, update);
      } catch {
        current();
        const latest = this.entries.get(key)!;
        if (latest.revision === revision) {
          latest.value = { ...latest.value, status: 'failed' };
          latest.attemptedAt = this.now();
        }
      }
      return this.peek(key);
    })();
    entry.pending = pending;
    try {
      return await pending;
    } finally {
      const latest = this.entries.get(key);
      if (latest?.pending === pending) delete latest.pending;
    }
  }
}
