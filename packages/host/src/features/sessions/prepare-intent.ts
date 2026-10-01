import { z } from 'zod';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import {
  sessionIntentCommandSchema,
  type SessionIntentCommand,
} from '@moor/protocol/session-intent-protocol';
import { permissionItemJson } from '@moor/protocol/permission-review';
import { resolveRunSelection } from '@moor/protocol/run-config';
import { Flock, mirror, putMeta, type LoroDoc } from '@moor/session/model';

export function assertSessionIntentScope(
  workspace: RuntimeWorkspace,
  input: SessionIntentCommand['value'],
  localProjectId?: string,
) {
  assert(
    input.workspaceId === workspace.id &&
      input.userId === workspace.userId &&
      input.machineId === workspace.machineId &&
      (!localProjectId || input.localProjectId === localProjectId) &&
      workspace.projects.some((project) => project.id === input.localProjectId),
    400,
    '会话意图与原执行目标不匹配',
  );
}

/** Prepare only Host-authored edits; the caller commits them with the original intent receipt. */
export function prepareSessionIntent(
  original: LoroDoc,
  originalMeta: Flock,
  meta: Record<string, unknown>,
  workspace: RuntimeWorkspace,
  command: SessionIntentCommand,
  now: string,
) {
  const parsed = sessionIntentCommandSchema.parse(command),
    input = parsed.value;
  assertSessionIntentScope(workspace, input);
  assert(
    meta.id === input.sessionId &&
      meta.userId === input.userId &&
      meta.machineId === input.machineId &&
      (meta.project as { kind?: unknown } | undefined)?.kind === 'local' &&
      (meta.project as { localProjectId?: unknown } | undefined)?.localProjectId ===
        input.localProjectId,
    409,
    '请先读取主机已确认的原会话',
  );
  assert(meta.isArchived !== true, 409, '请先恢复已归档会话');
  assert((meta.latestUserMsgId ?? null) === input.expectedTurnId, 409, '会话已更新，请重新读取');
  const candidate = original.fork();
  candidate.setPeerId(original.peerIdStr);
  const view = mirror(candidate, input.sessionId);
  let prepared = false;
  try {
    const state = view.getState();
    assert(state.session.id === input.sessionId, 409, '会话文档身份不匹配');
    let flock = originalMeta;
    if (parsed.kind === 'send-turn') {
      const request = parsed.value,
        agent = workspace.agents.find((agent) => agent.id === request.agentId);
      assert(
        agent &&
          agent.id === meta.agentConfigId &&
          agent.cliType === meta.cliType &&
          agent.agentType === meta.agentType,
        409,
        'Agent 与会话固定版本不匹配',
      );
      assert(
        !state.history.some((turn) => turn.role === 'assistant' && !turn.finished) &&
          (!meta.latestUserMsgId || meta.latestUserMsgId === meta.lastHandledUserMsgId),
        409,
        '当前回合尚未结束或已有指令等待执行',
      );
      assert(
        !state.history.some((turn) => turn.id === request.turnId),
        409,
        '新用户回合编号已经存在',
      );
      let run: ReturnType<typeof resolveRunSelection>;
      try {
        run = resolveRunSelection(request.selection, agent.runConfig);
      } catch (error) {
        assert(false, 400, (error as Error).message);
      }
      const timestamp = z.string().datetime().parse(now);
      view.setState((next) => {
        next.history.push({
          id: request.turnId,
          role: 'user',
          userId: request.userId,
          timestamp,
          status: 'pending',
          finished: true,
          read: undefined,
          userTurnId: undefined,
          inputConfig: {
            ...run,
            prompt: request.prompt,
            cliType: agent.cliType,
            agentType: agent.agentType,
            mcpServerIds: [],
            taskToolsEnabled: false,
            ...(request.attachments.length ? { attachments: request.attachments } : {}),
          },
          items: [
            { type: 'text', text: request.prompt },
            ...request.attachments.map((attachment) => ({
              type: 'attachment' as const,
              attachment,
            })),
          ],
          fileDiff: null,
        });
      });
      flock = Flock.fromFile(originalMeta.exportFile());
      putMeta(flock, 'session-' + request.sessionId, {
        latestUserMsgId: request.turnId,
        lastMessageAt: Date.parse(timestamp),
      });
    } else {
      const request = parsed.value;
      const matches = state.history.flatMap((turn, turnIndex) =>
        (turn.items ?? []).flatMap((item, itemIndex) => {
          const tool = item as Record<string, any>;
          return tool?.permissionRequest?.requestId === request.requestId
            ? [{ turn, tool, turnIndex, itemIndex }]
            : [];
        }),
      );
      assert(matches.length === 1, 409, '审批请求已失效或编号不唯一');
      const { turn, tool, turnIndex, itemIndex } = matches[0]!;
      assert(
        tool.type === 'tool_call' &&
          turn.role === 'assistant' &&
          !turn.finished &&
          turn.userTurnId === request.expectedTurnId &&
          turn.id === request.permissionReview.assistantTurnId &&
          (tool.permissionRequest.outcome === undefined || tool.permissionRequest.outcome === null),
        409,
        '审批不属于当前未结束的回合',
      );
      let reviewed = false;
      try {
        reviewed = permissionItemJson(tool) === request.permissionReview.itemJson;
      } catch {
        // Unreviewable Host content cannot receive an earlier decision.
      }
      assert(reviewed, 409, '审批请求内容已改变，请重新读取并审阅');
      assert(
        request.outcome.outcome === 'cancelled' ||
          (Array.isArray(tool.permissionRequest.options) &&
            tool.permissionRequest.options.some(
              (option: { optionId?: unknown }) =>
                request.outcome.outcome === 'selected' &&
                option.optionId === request.outcome.optionId,
            )),
        400,
        '审批选项不属于原请求',
      );
      view.setState((next) => {
        const item = next.history[turnIndex]!.items![itemIndex] as {
          permissionRequest: { outcome?: unknown };
        };
        item.permissionRequest.outcome = request.outcome;
      });
    }
    candidate.commit();
    prepared = true;
    return { doc: candidate, flock };
  } finally {
    view.dispose();
    if (!prepared) candidate.free();
  }
}
