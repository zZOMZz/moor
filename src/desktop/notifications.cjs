const { createHash } = require('node:crypto');
const EVENT_LIMIT = 1000;
const TERMINAL_TTL = 24 * 60 * 60 * 1000;
const APPROVAL_TTL = 30 * 60 * 1000;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) {
  return record(value) && Object.keys(value).every((key) => keys.includes(key));
}
function validateEvent(value) {
  const keys = [
    'notificationVersion',
    'eventId',
    'userId',
    'machineId',
    'workspaceId',
    'localProjectId',
    'sessionId',
    'turnId',
    'kind',
    'requestId',
    'createdAt',
    'expiresAt',
  ];
  if (
    !exact(value, keys) ||
    Buffer.byteLength(JSON.stringify(value)) > 3000 ||
    value.notificationVersion !== 1 ||
    typeof value.eventId !== 'string' ||
    !/^notification_[a-f0-9]{64}$/.test(value.eventId) ||
    typeof value.userId !== 'string' ||
    !value.userId.length ||
    value.userId.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(value.userId) ||
    !['machineId', 'workspaceId', 'localProjectId', 'sessionId', 'turnId'].every((key) =>
      id(value[key]),
    ) ||
    !['completed', 'failed', 'approval-required'].includes(value.kind) ||
    !['createdAt', 'expiresAt'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  )
    throw new Error('通知事件格式无效');
  const approval = value.kind === 'approval-required';
  if (
    (approval ? !id(value.requestId) : value.requestId !== undefined) ||
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > (approval ? APPROVAL_TTL : TERMINAL_TTL)
  )
    throw new Error('通知事件范围或有效期无效');
  const identity = JSON.stringify([
    1,
    value.userId,
    value.machineId,
    value.workspaceId,
    value.localProjectId,
    value.sessionId,
    value.turnId,
    approval ? ['approval', value.requestId] : 'terminal',
  ]);
  if (value.eventId !== 'notification_' + createHash('sha256').update(identity).digest('hex'))
    throw new Error('通知事件编号与范围不匹配');
  return structuredClone(value);
}
function notificationSettings(value) {
  return {
    enabled: value?.enabled === true,
    completed: typeof value?.completed === 'boolean' ? value.completed : true,
    failed: typeof value?.failed === 'boolean' ? value.failed : true,
    approvals: typeof value?.approvals === 'boolean' ? value.approvals : true,
  };
}
function validateSettings(value) {
  if (
    !exact(value, ['enabled', 'completed', 'failed', 'approvals']) ||
    !['enabled', 'completed', 'failed', 'approvals'].every((key) => typeof value[key] === 'boolean')
  )
    throw new Error('通知设置无效');
  return notificationSettings(value);
}
function notificationUrl(origin, event) {
  const value = validateEvent(event),
    url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('通知只能打开本机 Moor 工作区');
  url.searchParams.set('notification', JSON.stringify(value));
  return url.href;
}
const labels = {
  completed: '任务已完成',
  failed: '任务未完成，请查看状态',
  'approval-required': '任务需要你的审批',
};
/** Native notifications use only host-owned identifiers, never transcript text. */
class DesktopNotifications {
  /** @param {{Notification:any,load?:()=>any,save?:(value:any)=>void,getSettings?:()=>any,onClick?:(event:any)=>void,now?:()=>number,schedule?:typeof setTimeout,cancel?:typeof clearTimeout}} options */
  constructor({
    Notification,
    load = () => undefined,
    save = () => {},
    getSettings = () => undefined,
    onClick = () => {},
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
  }) {
    this.Notification = Notification;
    this.save = save;
    this.getSettings = getSettings;
    this.onClick = onClick;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.active = new Set();
    this.pending = new Map();
    this.lastStatus = 'idle';
    this.message = '通知默认关闭。可手动启用并测试系统显示。';
    this.seen = new Map();
    try {
      const saved = load();
      if (saved !== undefined) {
        if (
          !exact(saved, ['version', 'events']) ||
          saved.version !== 1 ||
          !Array.isArray(saved.events) ||
          saved.events.length > EVENT_LIMIT
        )
          throw new Error('Invalid notification cache');
        for (const item of saved.events) {
          if (
            !exact(item, ['eventId', 'expiresAt', 'status']) ||
            !/^notification_[a-f0-9]{64}$/.test(item.eventId) ||
            !Number.isSafeInteger(item.expiresAt) ||
            !['shown', 'failed', 'ignored'].includes(item.status)
          )
            throw new Error('Invalid notification cache');
          if (item.expiresAt > now()) this.seen.set(item.eventId, item);
        }
      }
    } catch {
      this.cacheFailed = true;
      this.lastStatus = 'failed';
      this.message = '本机通知记录无法读取，通知暂停；请检查本机数据目录。';
    }
  }
  state() {
    return {
      ...notificationSettings(this.getSettings()),
      supported: this.Notification.isSupported(),
      lastStatus: this.lastStatus,
      message: this.message,
    };
  }
  updateSettings() {
    const settings = notificationSettings(this.getSettings());
    for (const entry of this.active)
      if (
        !settings.enabled ||
        (entry.kind && !settings[entry.kind === 'approval-required' ? 'approvals' : entry.kind])
      )
        entry.finish('ignored');
    if (!settings.enabled) this.message = '本机通知已关闭。';
  }
  remember(event, status) {
    for (const [key, item] of this.seen) if (item.expiresAt <= this.now()) this.seen.delete(key);
    const next = new Map(this.seen);
    next.set(event.eventId, { eventId: event.eventId, expiresAt: event.expiresAt, status });
    while (next.size > EVENT_LIMIT) next.delete(next.keys().next().value);
    this.save({ version: 1, events: [...next.values()] });
    this.seen = next;
  }
  async receive(input) {
    const event = validateEvent(input);
    if (event.createdAt > this.now() + 60000) throw new Error('通知时间无效');
    if (event.expiresAt <= this.now()) return 'ignored';
    if (this.pending.has(event.eventId)) return this.pending.get(event.eventId);
    if (this.seen.has(event.eventId)) return this.seen.get(event.eventId).status;
    if (this.cacheFailed) return 'failed';
    const settings = notificationSettings(this.getSettings());
    const wanted =
      settings.enabled && settings[event.kind === 'approval-required' ? 'approvals' : event.kind];
    // A durable attempted marker prevents an app restart from replaying a toast
    // whose native result was never observed. Failed is intentionally not success.
    try {
      this.remember(event, wanted ? 'failed' : 'ignored');
    } catch {
      this.lastStatus = 'failed';
      this.message = '本机通知记录无法保存，未调用系统通知。';
      return 'failed';
    }
    if (!wanted) return 'ignored';
    const work = this.display(event.kind, event)
      .then((status) => {
        try {
          this.remember(event, status);
        } catch {
          this.lastStatus = 'failed';
          this.message = '系统通知结果未保存；不会自动重复显示。';
          return 'failed';
        }
        return status;
      })
      .finally(() => this.pending.delete(event.eventId));
    this.pending.set(event.eventId, work);
    return work;
  }
  test() {
    if (!notificationSettings(this.getSettings()).enabled) throw new Error('请先启用本机通知。');
    return this.display(undefined, undefined);
  }
  display(kind, event) {
    if (!this.Notification.isSupported()) {
      this.lastStatus = 'failed';
      this.message = '当前系统不支持原生通知。';
      return Promise.resolve('failed');
    }
    return new Promise((resolve) => {
      let settled = false,
        notification,
        timer;
      const closeNative = () => {
        try {
          notification?.close();
        } catch {}
      };
      const entry = { kind, finish: (status) => finish(status) };
      const finish = (status) => {
        if (settled) {
          if (status === 'ignored') {
            this.active.delete(entry);
            closeNative();
          }
          return;
        }
        settled = true;
        if (timer !== undefined) this.cancel(timer);
        this.lastStatus = status === 'shown' ? 'shown' : status === 'ignored' ? 'idle' : 'failed';
        this.message =
          status === 'shown'
            ? '系统已报告通知显示；是否出现横幅取决于系统通知与专注设置。'
            : status === 'ignored'
              ? '本机通知已关闭。'
              : '系统未确认通知显示；请检查通知权限与应用签名后手动测试。';
        if (status !== 'shown') {
          this.active.delete(entry);
          closeNative();
        }
        resolve(status);
      };
      try {
        notification = new this.Notification({
          title: 'Moor',
          body: kind ? labels[kind] : '这是一条 Moor 本机通知测试。',
          silent: false,
          hasReply: false,
        });
        notification.once('show', () => finish('shown'));
        notification.once('failed', () => finish('failed'));
        notification.once('close', () => {
          this.active.delete(entry);
          if (!settled) finish('ignored');
        });
        notification.on('click', () => {
          if (!notificationSettings(this.getSettings()).enabled) return;
          try {
            this.onClick(event);
          } catch {
            this.message = '通知对应的工作区暂不可用，请手动打开 Moor。';
          }
        });
        this.active.add(entry);
        if (this.active.size > 50) this.active.values().next().value.finish('ignored');
        timer = this.schedule(() => finish('failed'), 15000);
        notification.show();
      } catch {
        finish('failed');
      }
    });
  }
  close() {
    for (const entry of [...this.active]) entry.finish('ignored');
  }
}
module.exports = {
  DesktopNotifications,
  validateEvent,
  notificationSettings,
  validateSettings,
  notificationUrl,
};
