import { z } from 'zod';
import { agentSchema, mutationSchema } from './protocol';
import { decode, delta, Flock, LoroDoc, mirror, putMeta, vv } from './model';
import { resolveRunSelection, type RunSelection } from './run-config';
import { sessionReadResponseSchema, validateSessionBundle } from './session-responses';
import { taskPlanSchema, type TaskPlan } from './task-protocol';
import { mcpServerIdsSchema } from './mcp-protocol';
export type SessionClientScope = {
  userId: string;
  machineId: string;
  workspaceId: string;
  localProjectId: string;
  sessionId: string;
};
export function readClientSession(raw: unknown, scope: SessionClientScope) {
  const result = sessionReadResponseSchema.parse(raw);
  validateSessionBundle(result);
  if (
    result.meta.id !== scope.sessionId ||
    result.meta.userId !== scope.userId ||
    result.meta.machineId !== scope.machineId ||
    result.meta.project.localProjectId !== scope.localProjectId
  )
    throw new Error('会话响应与原执行范围不匹配');
  const doc = new LoroDoc();
  try {
    doc.import(decode(result.update));
    const view = mirror(doc, scope.sessionId);
    try {
      const state = view.getState();
      if (state.session.id !== scope.sessionId) throw new Error('会话文档身份不匹配');
      return { ...result, history: structuredClone(state.history) };
    } finally {
      view.dispose();
    }
  } finally {
    doc.free();
  }
}
export function buildSessionTurn(input: {
  scope: SessionClientScope;
  read: unknown;
  agent: z.infer<typeof agentSchema>;
  prompt: string;
  selection?: RunSelection;
  operationId: string;
  turnId: string;
  peerId: string;
  now: string;
  taskPlan?: TaskPlan;
  mcpServerIds?: string[];
}) {
  const read = readClientSession(input.read, input.scope),
    agent = agentSchema.parse(input.agent),
    taskPlan = input.taskPlan === undefined ? undefined : taskPlanSchema.parse(input.taskPlan);
  if (taskPlan && read.meta.taskOrigin) throw new Error('子任务不能创建下一层协作任务');
  if (read.persisted === false || read.persistenceError)
    throw new Error('主机结果尚未持久保存，不能据此发送新指令');
  if (read.meta.isArchived) throw new Error('请先恢复会话');
  if (
    read.meta.status?.type === 'working' ||
    read.history.some((t) => t.role === 'assistant' && !t.finished)
  )
    throw new Error('当前回合尚未结束');
  if (
    read.meta.agentConfigId !== agent.id ||
    read.meta.cliType !== agent.cliType ||
    read.meta.agentType !== agent.agentType
  )
    throw new Error('Agent 与会话固定版本不匹配');
  if (
    !input.prompt.trim() ||
    input.prompt.length > 100000 ||
    new TextEncoder().encode(input.prompt).byteLength > 1024 * 1024
  )
    throw new Error('指令必须为 100000 字符且 1 MiB 以内的非空文本');
  const time = z.string().datetime().parse(input.now),
    doc = new LoroDoc();
  doc.import(decode(read.update));
  const flock = Flock.fromJson(
      read.metaBundle as Parameters<typeof Flock.fromJson>[0],
      input.peerId,
    ),
    before = vv(doc),
    version = flock.version(),
    view = mirror(doc, input.scope.sessionId);
  try {
    const run = resolveRunSelection(input.selection ?? {}, agent.runConfig);
    view.setState((s) => {
      s.history.push({
        id: input.turnId,
        role: 'user',
        userId: input.scope.userId,
        timestamp: time,
        status: 'pending',
        finished: true,
        read: undefined,
        userTurnId: undefined,
        inputConfig: {
          ...run,
          prompt: input.prompt,
          cliType: agent.cliType,
          agentType: agent.agentType,
          mcpServerIds: mcpServerIdsSchema.parse(input.mcpServerIds ?? []),
          taskToolsEnabled: !!taskPlan,
          ...(taskPlan ? { taskPlan } : {}),
        },
        items: [{ type: 'text', text: input.prompt }],
        fileDiff: null,
      });
    });
    doc.commit();
    putMeta(flock, 'session-' + input.scope.sessionId, {
      latestUserMsgId: input.turnId,
      lastMessageAt: Date.parse(time),
    });
    return mutationSchema.parse({
      operationId: input.operationId,
      workspaceId: input.scope.workspaceId,
      sessionId: input.scope.sessionId,
      kind: 'turn',
      expectedTurnId: read.meta.latestUserMsgId ?? null,
      update: delta(doc, before),
      metaBundle: flock.exportJson(version),
    });
  } finally {
    view.dispose();
    doc.free();
  }
}
