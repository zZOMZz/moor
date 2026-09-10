// Synthetic ACP process for manual integration validation; never accesses project files or models.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n');
const pending = new Map();
let sequence = 0;
function update(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const m = JSON.parse(line);
    if (!m.method) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        update(p.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: p.toolCallId,
          status: 'completed',
        });
        update(p.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '验证完成：审批响应已到达执行电脑。项目文件未修改。' },
        });
        send({ id: p.promptId, result: { stopReason: 'end_turn' } });
      }
      return;
    }
    if (m.method === 'initialize')
      return send({
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: 'Synthetic validation agent', version: '1.0.0' },
          authMethods: [],
        },
      });
    if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: randomUUID() } });
    if (
      m.method === 'session/load' ||
      m.method === 'session/resume' ||
      m.method === 'session/set_mode' ||
      m.method === 'session/set_config_option'
    )
      return send({ id: m.id, result: {} });
    if (m.method === 'session/prompt') {
      const sessionId = m.params.sessionId,
        toolCallId = randomUUID();
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '已在目标电脑接收指令。下面请求一次合成操作确认。' },
      });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: '合成审批验证（不修改文件）',
        kind: 'edit',
        status: 'pending',
        content: [
          {
            type: 'diff',
            path: 'synthetic-example.ts',
            oldText: 'const connected = false;',
            newText: 'const connected = true;',
          },
        ],
      });
      const id = 'permission-' + ++sequence;
      pending.set(id, { sessionId, toolCallId, promptId: m.id });
      return send({
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId,
            title: '合成审批验证（不修改文件）',
            kind: 'edit',
            status: 'pending',
          },
          options: [
            { optionId: 'allow', name: '允许这次验证', kind: 'allow_once' },
            { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
          ],
        },
      });
    }
    if (m.method === 'session/cancel') {
      for (const [id, p] of pending)
        if (p.sessionId === m.params.sessionId) {
          pending.delete(id);
          send({ id: p.promptId, result: { stopReason: 'cancelled' } });
        }
      return;
    }
    if (m.id !== undefined)
      send({
        id: m.id,
        error: { code: -32601, message: 'Unsupported synthetic method: ' + m.method },
      });
  } catch (e) {
    process.stderr.write(String(e) + '\n');
  }
});
