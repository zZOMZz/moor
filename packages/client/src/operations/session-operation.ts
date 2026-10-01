import { attachmentReceiptSchema } from '@moor/protocol/attachment-protocol';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
import type { HostCommand } from '@moor/protocol/host-command';
import {
  validateSessionControlReceipt,
  validateSessionOperationResult,
  type SessionControlScope,
  type SessionOriginalOperation,
} from '@moor/protocol/session-control-protocol';
import {
  mutationReceiptSchema,
  validateSessionActionReceipt,
} from '@moor/protocol/session-responses';

type OriginalMethod = Extract<
  HostCommand['method'],
  | 'session-control'
  | 'session-action'
  | 'attachment-action'
  | 'send-turn'
  | 'respond-permission'
  | 'mutate'
  | 'session-operations'
>;
/** The caller binds account/device/connection, holds the original-operation lock,
 * and checks that binding before and after dispatch. Persistence follows confirmation. */
export interface OriginalOperationPort {
  dispatch(method: OriginalMethod, input: unknown): Promise<unknown>;
}
export class ConfirmationPersistenceFailure extends Error {
  constructor(
    readonly operationId: string,
    readonly hostStatus: 'confirmed' | 'abandoned' | 'pending',
    cause: unknown,
  ) {
    super('主机已确认本次原操作的状态，但本机结果记录保存失败；原请求已保留，请手动核查。', {
      cause,
    });
    this.name = 'ConfirmationPersistenceFailure';
  }
}
/** Cache/ledger failures cannot turn an authenticated Host confirmation into a
 * transport failure. They never authorize automatic replay of the durable original. */
export async function persistOriginalConfirmation<T>(
  operationId: string,
  hostStatus: 'confirmed' | 'abandoned' | 'pending',
  current: () => void,
  write: () => T | Promise<T>,
): Promise<T> {
  current();
  try {
    return await write();
  } catch (cause) {
    current();
    throw new ConfirmationPersistenceFailure(operationId, hostStatus, cause);
  }
}
export function originalOperationMethod(original: SessionOriginalOperation): OriginalMethod {
  switch (original.kind) {
    case 'control':
      return 'session-control';
    case 'metadata':
      return 'session-action';
    case 'attachment':
      return 'attachment-action';
    case 'send-turn':
      return 'send-turn';
    case 'respond-permission':
      return 'respond-permission';
    case 'mutation':
      return 'mutate';
  }
}
function assertScope(scope: SessionControlScope, original: SessionOriginalOperation) {
  const value = original.value;
  if (
    value.workspaceId !== scope.workspaceId ||
    value.sessionId !== scope.sessionId ||
    ('localProjectId' in value && value.localProjectId !== scope.localProjectId) ||
    ('userId' in value && (value.userId !== scope.userId || value.machineId !== scope.machineId))
  )
    throw Error('原操作与完整执行范围不匹配；未发送。');
}
export async function deliverOriginalOperation(
  scope: SessionControlScope,
  original: SessionOriginalOperation,
  port: OriginalOperationPort,
) {
  assertScope(scope, original);
  const raw = await port.dispatch(originalOperationMethod(original), original.value);
  if (original.kind === 'control') {
    const receipt = validateSessionControlReceipt(raw, scope, original);
    return {
      receipt,
      status:
        receipt.status === 'stopping'
          ? ('pending' as const)
          : receipt.status === 'abandoned'
            ? ('abandoned' as const)
            : ('confirmed' as const),
      interrupted: receipt.status === 'interrupted',
    };
  }
  if (original.kind === 'metadata') {
    const receipt = validateSessionActionReceipt(original.value, raw);
    if (
      receipt.accepted &&
      (receipt.meta.userId !== scope.userId || receipt.meta.machineId !== scope.machineId)
    )
      throw Error('会话回执不属于原执行身份。');
    return {
      receipt,
      status: receipt.accepted ? ('confirmed' as const) : ('abandoned' as const),
      interrupted: false,
    };
  }
  if (original.kind === 'attachment') {
    const receipt = attachmentReceiptSchema.parse(raw),
      value = original.value;
    if (
      receipt.operationId !== value.operationId ||
      receipt.workspaceId !== scope.workspaceId ||
      receipt.localProjectId !== scope.localProjectId ||
      receipt.sessionId !== scope.sessionId ||
      (value.action === 'upload'
        ? productCanonicalJson(receipt.attachment) !== productCanonicalJson(value.attachment)
        : receipt.removed !== true)
    )
      throw Error('附件回执与完整原请求不匹配。');
    return { receipt, status: 'confirmed' as const, interrupted: false };
  }
  const receipt = mutationReceiptSchema.parse(raw);
  if (receipt.operationId !== original.value.operationId) throw Error('主机回执与原操作不匹配。');
  return {
    receipt,
    status: receipt.accepted ? ('confirmed' as const) : ('abandoned' as const),
    interrupted: false,
  };
}
export async function recoverOriginalOperation(
  scope: SessionControlScope,
  original: SessionOriginalOperation,
  action: 'inspect' | 'abandon',
  port: OriginalOperationPort,
) {
  assertScope(scope, original);
  const input = {
    controlVersion: 1 as const,
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    sessionId: scope.sessionId,
    userId: scope.userId,
    machineId: scope.machineId,
    action,
    request: original,
  };
  return validateSessionOperationResult(await port.dispatch('session-operations', input), input);
}
