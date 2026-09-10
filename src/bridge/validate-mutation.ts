import { isDeepStrictEqual } from 'node:util';
import { assert, type Mutation, type Workspace } from '../protocol';
import { Flock, LoroDoc, decode, metas, mirror } from '../model';
const clone = (source: LoroDoc) => {
  const d = new LoroDoc();
  d.import(source.export({ mode: 'snapshot' }));
  return d;
};
// Validation runs on the execution host before importing browser-authored operations.
export function validateMutation(
  originalDoc: LoroDoc,
  originalFlock: Flock,
  ws: Workspace,
  m: Mutation,
) {
  const name = 'session-' + m.sessionId,
    flock = Flock.fromFile(originalFlock.exportFile());
  const beforeRows = metas(flock),
    old = beforeRows[name];
  assert((old?.latestUserMsgId ?? null) === m.expectedTurnId, 409, '会话已更新，请刷新后发送');
  const before = clone(originalDoc),
    beforeMirror = mirror(before, m.sessionId);
  const oldState = structuredClone(beforeMirror.getState());
  beforeMirror.dispose();
  const doc = clone(originalDoc);
  doc.import(decode(m.update));
  doc.commit();
  const view = mirror(doc, m.sessionId),
    next = structuredClone(view.getState());
  view.dispose();
  if (m.metaBundle) flock.importJson(m.metaBundle as never);
  flock.commit();
  const afterRows = metas(flock),
    meta = afterRows[name];
  // No edits to another session/machine/registry row can ride this endpoint.
  const original = originalFlock;
  const beforeKeys = original.scan({}),
    afterKeys = flock.scan({});
  const allowed = new Set([
    'id',
    'machineId',
    'userId',
    'createdAt',
    'cliType',
    'agentType',
    'agentConfigId',
    'project',
    'title',
    'titleSource',
    'status',
    'isArchived',
    'latestUserMsgId',
    'lastMessageAt',
  ]);
  const filter = (rows: typeof beforeKeys) =>
    rows.filter(
      (r) =>
        !(
          r.key[1] === name &&
          ((r.key[0] === 'm' && allowed.has(String(r.key[2]))) || r.key[0] === 'e')
        ),
    );
  assert(isDeepStrictEqual(filter(beforeKeys), filter(afterKeys)), 400, '包含不受支持的元数据变更');
  assert(
    meta?.id === m.sessionId && meta.machineId === ws.machineId && meta.userId === ws.userId,
    400,
    '会话执行目标不匹配',
  );
  const project = meta.project as any,
    agent = ws.agents.find((a) => a.id === meta.agentConfigId);
  assert(
    project?.kind === 'local' && ws.projects.some((p) => p.id === project.localProjectId),
    400,
    '请先在执行电脑登记项目',
  );
  assert(
    agent && agent.cliType === meta.cliType && agent.agentType === meta.agentType,
    400,
    'Agent 配置不可用',
  );
  if (old) {
    for (const key of allowed)
      if (!['latestUserMsgId', 'lastMessageAt'].includes(key))
        assert(isDeepStrictEqual(old[key], meta[key]), 400, '已有会话的执行目标不可改变');
  }
  if (m.kind === 'turn') {
    assert(
      !oldState.history.some((t) => t.role === 'assistant' && !t.finished),
      409,
      'Agent 正在运行，请等待完成或停止',
    );
    assert(
      !old || !old.latestUserMsgId || old.latestUserMsgId === old.lastHandledUserMsgId,
      409,
      '已有指令等待执行',
    );
    assert(
      next.history.length === oldState.history.length + 1 &&
        isDeepStrictEqual(next.history.slice(0, -1), oldState.history),
      400,
      '仅允许追加一个用户回合',
    );
    const turn = next.history.at(-1)!;
    assert(
      isDeepStrictEqual({ ...oldState, history: next.history }, next),
      400,
      '包含额外文档修改',
    );
    assert(
      turn.role === 'user' && turn.userId === ws.userId && turn.id === meta.latestUserMsgId,
      400,
      '用户回合不匹配',
    );
    assert(
      turn.inputConfig?.cliType === agent.cliType && turn.inputConfig.agentType === agent.agentType,
      400,
      'Agent 不匹配',
    );
    assert(
      turn.inputConfig.prompt.length > 0 && turn.inputConfig.prompt.length <= 100000,
      400,
      '指令为空或过长',
    );
    assert(
      Object.keys(turn.inputConfig).every((k) =>
        ['prompt', 'cliType', 'agentType', 'mcpServerIds', 'taskToolsEnabled'].includes(k),
      ),
      400,
      '不允许远程注入启动配置',
    );
    assert(
      isDeepStrictEqual(turn.inputConfig.mcpServerIds, []) &&
        turn.inputConfig.taskToolsEnabled === false,
      400,
      '初版远程会话不挂载额外 MCP',
    );
  } else {
    assert(m.requestId && isDeepStrictEqual(beforeRows, afterRows), 400, '审批不能修改会话目标');
    let matched = false;
    for (let i = 0; i < oldState.history.length; i++)
      for (let j = 0; j < (oldState.history[i].items ?? []).length; j++) {
        const item: any = oldState.history[i].items![j],
          target: any = next.history[i]?.items?.[j];
        if (item.permissionRequest?.requestId !== m.requestId) continue;
        assert(
          !matched && !oldState.history[i].finished && !item.permissionRequest.outcome,
          409,
          '审批请求已失效',
        );
        const result = target?.permissionRequest?.outcome;
        assert(
          result &&
            (result.outcome === 'cancelled' ||
              (result.outcome === 'selected' &&
                item.permissionRequest.options.some((o: any) => o.optionId === result.optionId))),
          400,
          '审批选项无效',
        );
        item.permissionRequest.outcome = result;
        matched = true;
      }
    assert(matched && isDeepStrictEqual(oldState, next), 400, '审批包含其他会话修改');
  }
  return { doc, flock };
}
