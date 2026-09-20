import {
  collaborationKey,
  collaborationOperationSchema,
  type CollaborationOperation,
  type CollaborationScope,
} from '@moor/protocol/collaboration-protocol';

/** Immutable operation union: delivery order and repetition do not decide whose text survives. */
export function mergeCollaborationOperations(
  scope: CollaborationScope,
  ...replicas: readonly (readonly CollaborationOperation[])[]
): CollaborationOperation[] {
  const key = collaborationKey(scope),
    operations = new Map<string, CollaborationOperation>();
  for (const replica of replicas)
    for (const raw of replica) {
      const operation = collaborationOperationSchema.parse(raw);
      if (collaborationKey(operation.scope) !== key) throw Error('协作操作超出当前会话范围');
      const previous = operations.get(operation.operationId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(operation))
        throw Error('协作操作编号对应不同内容');
      operations.set(operation.operationId, operation);
    }
  return [...operations.values()].sort((a, b) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
  );
}

/** Used by the accepting sync authority before acknowledging new authored operations. */
export function validateCollaborationDependencies(
  operation: CollaborationOperation,
  previous: readonly CollaborationOperation[],
) {
  const byId = new Map(previous.map((entry) => [entry.operationId, entry]));
  if (operation.kind === 'withdraw') {
    const submitted = byId.get(operation.taskId);
    if (
      submitted?.kind !== 'submit' ||
      collaborationKey(submitted.scope) !== collaborationKey(operation.scope)
    )
      throw Error('撤回目标不是当前范围内的已提交任务');
  }
}
