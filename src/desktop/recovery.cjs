// Owns only the process returned by launch. Recovery never replays an agent request.
class ProcessRecovery {
  constructor({ launch, onState, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { launch, onState, now, schedule, cancel });
    this.child = null;
    this.timer = null;
    this.attempt = 0;
    this.healthyAt = null;
    this.stopped = false;
    this.state = 'stopped';
  }
  update(state, message) {
    this.state = state;
    this.onState({ state, message, attempt: this.attempt });
  }
  start() {
    if (this.child || this.timer !== null || this.stopped) return;
    this.update('starting', '正在启动本机执行组件');
    let child;
    try {
      child = this.launch();
    } catch {
      this.failed(null);
      return;
    }
    this.child = child;
    child.on('error', () => {}); // close follows spawn errors; recover once, with a safe public message.
    child.once('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopped) this.failed(code);
    });
  }
  ready() {
    if (!this.child || this.stopped) return;
    if (this.healthyAt === null) this.healthyAt = this.now();
    this.update('ready', '本机执行组件已就绪');
  }
  failed(code) {
    if (this.healthyAt !== null && this.now() - this.healthyAt >= 60_000) this.attempt = 0;
    this.healthyAt = null;
    if (code === 3) {
      this.update(
        'blocked',
        '已有 Moor 执行实例占用本机数据目录。请正常退出该实例后点击“重新连接”。',
      );
      return;
    }
    const delays = [1000, 3000, 10000];
    if (this.attempt >= delays.length) {
      this.update('failed', '执行组件连续退出，自动恢复已暂停。检查本机环境后点击“重新连接”。');
      return;
    }
    const delay = delays[this.attempt++];
    this.update(
      'recovering',
      `执行组件已退出，${delay / 1000} 秒后尝试恢复（${this.attempt}/3）。进行中的回合不会自动重放。`,
    );
    this.timer = this.schedule(() => {
      this.timer = null;
      this.start();
    }, delay);
  }
  retry() {
    if (this.child || this.stopped) return false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.healthyAt = null;
    this.start();
    return true;
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.child?.kill('SIGTERM');
  }
}
module.exports = { ProcessRecovery };
