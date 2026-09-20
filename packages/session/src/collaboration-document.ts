import {
  collaborationKey,
  collaborationOperationSchema,
  type CollaborationOperation,
  type CollaborationScope,
  type SharedDraftRevision,
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

/** A concurrent edit remains visible until a new revision names all heads it resolves. */
export function sharedDraftHeads(
  operations: readonly CollaborationOperation[],
  draftId: string,
): SharedDraftRevision[] {
  const revisions = operations.filter(
      (operation): operation is SharedDraftRevision =>
        operation.kind === 'draft' && operation.draftId === draftId,
    ),
    consumed = new Set(revisions.flatMap((revision) => revision.parents));
  return revisions.filter((revision) => !consumed.has(revision.operationId));
}

/** Used by the accepting sync authority before acknowledging new authored operations. */
export function validateCollaborationDependencies(
  operation: CollaborationOperation,
  previous: readonly CollaborationOperation[],
) {
  const byId = new Map(previous.map((entry) => [entry.operationId, entry]));
  if (operation.kind === 'draft') {
    for (const parentId of operation.parents) {
      const parent = byId.get(parentId);
      if (
        parent?.kind !== 'draft' ||
        parent.draftId !== operation.draftId ||
        collaborationKey(parent.scope) !== collaborationKey(operation.scope)
      )
        throw Error('草稿缺少同一范围下的前置版本');
    }
  } else if (operation.kind === 'submit') {
    const revision = byId.get(operation.draftRevisionId);
    if (
      revision?.kind !== 'draft' ||
      revision.draftId !== operation.draftId ||
      collaborationKey(revision.scope) !== collaborationKey(operation.scope) ||
      JSON.stringify(revision.input) !== JSON.stringify(operation.input)
    )
      throw Error('执行授权必须绑定已保存的精确草稿内容');
  } else {
    const submitted = byId.get(operation.taskId);
    if (
      submitted?.kind !== 'submit' ||
      collaborationKey(submitted.scope) !== collaborationKey(operation.scope)
    )
      throw Error('撤回目标不是当前范围内的已提交任务');
  }
}
