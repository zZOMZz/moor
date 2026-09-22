import {
  prepareSessionTurn,
  prepareSessionPermission,
  type SessionTurnInput,
} from '@moor/session/session-operations';
import { sendTurnSchema, respondPermissionSchema } from '@moor/protocol/session-intent-protocol';
import { selectionFromInput } from '@moor/protocol/run-config';

/** Validate the reviewed read, then freeze business input without creating document edits. */
export function buildSendTurn(input: SessionTurnInput & { operationId: string; turnId: string }) {
  const { read, agent, attachments, run } = prepareSessionTurn(input),
    selection = selectionFromInput(run, agent.runConfig);
  return sendTurnSchema.parse({
    intentVersion: 1,
    operationId: input.operationId,
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    machineId: input.scope.machineId,
    localProjectId: input.scope.localProjectId,
    sessionId: input.scope.sessionId,
    expectedTurnId: read.meta.latestUserMsgId ?? null,
    agentId: agent.id,
    turnId: input.turnId,
    prompt: input.prompt,
    selection: {
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(selection.modeId ? { modeId: selection.modeId } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    },
    attachments,
  });
}

export function buildRespondPermission(input: Parameters<typeof prepareSessionPermission>[0]) {
  const { review, outcome } = prepareSessionPermission(input);
  return respondPermissionSchema.parse({
    intentVersion: 1,
    operationId: input.operationId,
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    machineId: input.scope.machineId,
    localProjectId: input.scope.localProjectId,
    sessionId: input.scope.sessionId,
    expectedTurnId: review.expectedUserTurnId,
    requestId: review.requestId,
    permissionReview: {
      version: 1,
      assistantTurnId: review.assistantTurnId,
      itemJson: review.itemJson,
    },
    outcome,
  });
}
