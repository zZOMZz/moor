import {
  legacyContentEntriesSchema,
  legacyContentPrefix,
  parseLegacyContentEntry,
} from '../web/legacy-project-content';
import { Flock, metas } from '../model';
import { actorSchema, actorKey } from '../attention';
import {
  workspaceAttentionBucketSchema,
  validateWorkspaceAttentionBucket,
  validateWorkspaceAttentionEntry,
} from '../web/workspace-attention';
import { legacyAttentionPrefix, legacyReadSelection } from './legacy-cache-keys.cjs';
import { githubStoredSchema, githubKey } from '../web/github';
import { githubWriteStoredSchema, githubWriteKey } from '../web/github-write';
import { validateWorkspaceGithub, validateWorkspaceGithubWrite } from '../web/workspace-github';
import { z } from 'zod';
import { agentSchema, id, mutationSchema } from '../protocol';
import { desktopWorkspaceSourceSchema, desktopWorkspaceTargetSchema } from './workspace-protocol';
import { sessionMetadataSchema, sessionBase64Schema } from '../session-responses';
import { readLegacyClientSession } from '../session-client';
import { runSelectionSchema } from '../run-config';
import { pendingSessionActionSchema, sessionActionKey } from '../web/session-actions';
import { legacySessionExtensionKeys } from './legacy-cache-keys.cjs';
import { attachmentDraftSchema, attachmentDraftKey } from '../web/attachments';
import { interactionSavedSchema, interactionKey, interactionScope } from '../web/interactions';
import { mcpStoredSchema, mcpKey } from '../web/mcp';
import { validateWorkspaceMcp } from '../web/workspace-mcp';
import { gitStoredSchema, gitWorkspaceKey } from '../web/git-workspace';
import { validateWorkspaceGit } from '../web/workspace-git';
import { forkStoredSchema, sessionForkKey } from '../web/session-fork';
import { validateWorkspaceFork } from '../web/workspace-fork';
import { tasksStoredSchema, tasksKey } from '../web/tasks';
import { validateWorkspaceTasks } from '../web/workspace-tasks';
import { rolesStoredSchema, roleAppliedSchema, rolesKey, roleAppliedKey } from '../web/roles';
import { validateWorkspaceRoles, validateWorkspaceRoleApplied } from '../web/workspace-roles';
import {
  previewStoredSchema,
  previewAnnotationsStoredSchema,
  pendingPreviewMutationSchema,
  previewAnnotationSubmissionSchema,
  projectPreviewKey,
  previewAnnotationKey,
} from '../web/project-preview';
import { validateWorkspacePreview } from '../web/workspace-preview';
import { workspaceFeatureTarget } from '../web/workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

export const legacyCacheScopeSchema = z
  .object({
    source: desktopWorkspaceSourceSchema,
    origin: z.string().url().max(2048),
    target: desktopWorkspaceTargetSchema.omit({ sessionId: true }).strict(),
  })
  .strict();
const snapshotSchema = z
  .object({
    snapshot: sessionBase64Schema,
    meta: sessionMetadataSchema,
    metaBundle: z
      .object({ version: z.number().int().nonnegative(), entries: z.record(z.unknown()) })
      .strict(),
    agent: agentSchema.optional(),
  })
  .strict();
export const legacySessionRecoverySchema = z
  .object({
    version: z.literal(1),
    scope: legacyCacheScopeSchema,
    sessionId: id,
    title: z.string().max(220),
    draft: z.string().max(100000).optional(),
    draftActor: actorSchema.optional(),
    attention: workspaceAttentionBucketSchema.optional(),
    selection: runSelectionSchema.optional(),
    content: legacyContentEntriesSchema.optional(),
    snapshot: snapshotSchema,
    pending: mutationSchema.strict().optional(),
    metadata: pendingSessionActionSchema.optional(),
    attachments: attachmentDraftSchema.optional(),
    interactions: interactionSavedSchema.optional(),
    mcp: mcpStoredSchema.optional(),
    git: gitStoredSchema.optional(),
    github: githubStoredSchema.optional(),
    githubWrite: githubWriteStoredSchema.optional(),
    fork: forkStoredSchema.optional(),
    tasks: tasksStoredSchema.optional(),
    roles: rolesStoredSchema.optional(),
    roleApplied: roleAppliedSchema.optional(),
    preview: previewStoredSchema.optional(),
    annotations: previewAnnotationsStoredSchema.optional(),
    annotationDelivery: previewAnnotationSubmissionSchema.optional(),
    unresolvedKeys: z.array(z.string().max(4096)).max(10000),
  })
  .strict();
export type LegacySessionRecovery = z.infer<typeof legacySessionRecoverySchema>;
export const legacyDraftRecoverySchema = legacySessionRecoverySchema
  .omit({ snapshot: true, sessionId: true, title: true })
  .extend({ kind: z.literal('draft'), sessionId: id.optional(), agentId: id.optional() })
  .strict();
export type LegacyDraftRecovery = z.infer<typeof legacyDraftRecoverySchema>;
export const legacyReservedDraftSchema = legacyDraftRecoverySchema
  .extend({ sessionId: id })
  .strict();
export type LegacyReservedDraft = z.infer<typeof legacyReservedDraftSchema>;
export const legacyRestorableSchema = z.union([
  legacySessionRecoverySchema,
  legacyReservedDraftSchema,
]);
export type LegacyRestorable = z.infer<typeof legacyRestorableSchema>;
export function matchesLegacyDraft(saved: LegacyReservedDraft, source: LegacyDraftRecovery) {
  const value = { ...saved } as LegacyDraftRecovery;
  if (!source.sessionId) delete value.sessionId;
  return canonical(value) === canonical(source);
}
export const legacyReadSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: id.regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z.object({ kind: z.literal('new') }).strict(),
]);
export type LegacyReadSelection = z.infer<typeof legacyReadSelectionSchema>;
export const legacyIndexCursorSchema = z
  .object({ version: z.string().regex(/^sha256:[a-f0-9]{64}$/), after: id })
  .strict();
export type LegacyIndexCursor = z.infer<typeof legacyIndexCursorSchema>;
export const legacyIndexSchema = z
  .object({
    scope: legacyCacheScopeSchema,
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sessionIds: z.array(id).max(100),
    total: z.number().int().nonnegative().max(100000),
    hasNew: z.boolean(),
    nextCursor: legacyIndexCursorSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.sessionIds.length <= value.total &&
      value.sessionIds.every((id, i) => i === 0 || id > value.sessionIds[i - 1]!) &&
      (!value.nextCursor ||
        (value.nextCursor.version === value.version &&
          value.nextCursor.after === value.sessionIds.at(-1))),
  );
export type LegacyIndex = z.infer<typeof legacyIndexSchema>;
export const legacyCacheRecoverySchema = z
  .object({
    version: z.literal(1),
    scope: legacyCacheScopeSchema,
    selection: legacyReadSelectionSchema.optional(),
    sessions: z.array(legacySessionRecoverySchema).max(10000),
    newDraft: legacyDraftRecoverySchema.optional(),
    unassignedDraft: z.string().max(100000).optional(),
    unresolved: z.number().int().nonnegative().max(10000),
  })
  .strict();
export type LegacyCacheRecovery = z.infer<typeof legacyCacheRecoverySchema>;
export function legacySessionRead(record: LegacySessionRecovery) {
  return {
    ...record.snapshot,
    update: record.snapshot.snapshot,
    synced: true as const,
    online: true as const,
    persisted: false,
  };
}

/** Only an existing session cache proves the project for an old slash-keyed draft. */
export function normalizeLegacyCache(input: {
  source: unknown;
  origin: unknown;
  target: unknown;
  records: unknown;
  actor?: unknown;
  selection?: unknown;
}) {
  const scope = legacyCacheScopeSchema.parse({
      source: input.source,
      origin: input.origin,
      target: input.target,
    }),
    target = scope.target;
  const selection =
    input.selection === undefined ? undefined : legacyReadSelectionSchema.parse(input.selection);
  const actor = input.actor === undefined ? undefined : actorSchema.parse(input.actor);
  if (actor && actor.accountId !== target.owner) throw Error('旧待办账号与当前连接不匹配。');
  const attentionRoute = actor
    ? {
        origin: scope.origin,
        actor,
        catalogWorkspaceId: target.catalogWorkspaceId,
        projectId: target.catalogProjectId,
        replicaId: target.replicaId,
        executionDeviceId: target.deviceId,
        machineId: target.machineId,
        runtimeWorkspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
      }
    : undefined;
  const attentionPrefix = actor ? legacyAttentionPrefix(target, scope.origin, actor) : undefined;
  const origin = new URL(scope.origin);
  if (
    scope.source === 'local'
      ? origin.protocol !== 'http:' ||
        origin.hostname !== '127.0.0.1' ||
        target.owner !== 'local-desktop' ||
        target.serverKey !== 'local:' + target.machineId
      : scope.origin !== target.serverKey
  )
    throw Error('旧缓存来源与原电脑不匹配。');
  if (origin.origin !== scope.origin || origin.username || origin.password)
    throw Error('旧缓存来源无效。');
  const records = z
    .array(z.object({ key: z.string().max(4096), value: z.unknown() }).strict())
    .max(10000)
    .parse(input.records);
  if (new Set(records.map((record) => record.key)).size !== records.length)
    throw Error('旧缓存含有重复记录。');
  if (
    new TextEncoder().encode(JSON.stringify(records)).byteLength >
    (selection ? 256 : 96) * 1024 * 1024
  )
    throw Error('旧缓存超出单次恢复大小。');
  const byKey = new Map(records.map(({ key, value }) => [key, value]));
  if (selection) {
    const selected = legacyReadSelection(target, scope.origin, actor, selection);
    const prefixes = [...selected.prefixes];
    if (selected.newDraft) {
      const hints = selected.newDraft;
      const pending = byKey.get(hints.pendingKey) as
        | { sessionId?: unknown; mutation?: { sessionId?: unknown } }
        | undefined;
      for (const value of [
        byKey.get(hints.reservationKey),
        pending?.mutation?.sessionId ?? pending?.sessionId,
      ]) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) continue;
        prefixes.push(
          ...hints.sessionPrefixes.map((prefix: string) => prefix + JSON.stringify(value)),
        );
        prefixes.push(hints.actionPrefix + value + '/session-action');
      }
    }
    if (records.some((record) => !prefixes.some((prefix) => record.key.startsWith(prefix))))
      throw Error('旧缓存页混入其他会话记录。');
  }

  const prefix = [target.owner, target.deviceId, target.workspaceId, ''].join('/');
  const sessions: LegacySessionRecovery[] = [];
  const covered = new Set<string>();
  for (const record of records) {
    if (!record.key.startsWith(prefix) || !record.key.endsWith('/session')) continue;
    const sessionId = record.key.slice(prefix.length, -'/session'.length);
    if (!id.safeParse(sessionId).success || sessionId === 'new') continue;
    const cached = snapshotSchema.safeParse(record.value);
    if (!cached.success) continue;
    const snapshot = cached.data;
    if (
      snapshot.meta.id !== sessionId ||
      snapshot.meta.machineId !== target.machineId ||
      snapshot.meta.userId !== target.userId ||
      snapshot.meta.project.localProjectId !== target.localProjectId
    )
      continue;
    try {
      readLegacyClientSession(
        { ...snapshot, update: snapshot.snapshot, synced: true, online: true, persisted: false },
        { ...target, sessionId },
      );
    } catch {
      continue;
    }
    const base = prefix + sessionId;
    const recovered: LegacySessionRecovery = {
      version: 1,
      scope,
      sessionId,
      title: snapshot.meta.title ?? '未命名会话',
      snapshot,
      unresolvedKeys: [],
    };
    covered.add(record.key);
    recoverPayload(recovered, base, sessionId, snapshot.meta.agentConfigId);
    sessions.push(recovered);
  }
  function recoverPayload(
    recovered: LegacySessionRecovery | LegacyDraftRecovery,
    base: string,
    sessionId?: string,
    agentId?: string,
    allowPending = true,
    composer = true,
  ) {
    const draft = composer ? byKey.get(base + '/draft') : undefined;
    if (typeof draft === 'string' && draft.length <= 100000) {
      recovered.draft = draft;
      covered.add(base + '/draft');
    }
    const marker = z
      .object({ scope: z.string(), text: z.string() })
      .strict()
      .safeParse(composer ? byKey.get(base + '/draft/actor') : undefined);
    if (
      actor &&
      marker.success &&
      marker.data.text === recovered.draft &&
      marker.data.scope === JSON.stringify([scope.origin, actorKey(actor)])
    ) {
      recovered.draftActor = actor;
      covered.add(base + '/draft/actor');
    }
    const attentionSessionPrefix =
      sessionId && attentionPrefix ? attentionPrefix + JSON.stringify(sessionId) + ',' : undefined;
    if (attentionRoute && attentionSessionPrefix) {
      const entries: Record<string, unknown> = {};
      for (const entry of records) {
        if (!entry.key.startsWith(attentionSessionPrefix) || entry.value == null) continue;
        try {
          entries[entry.key] = validateWorkspaceAttentionEntry(
            attentionRoute,
            entry.key,
            entry.value,
          );
          covered.add(entry.key);
        } catch {
          /* Unrecognized or changed execution bindings remain unresolved. */
        }
      }
      if (Object.keys(entries).length)
        recovered.attention = validateWorkspaceAttentionBucket(
          { route: attentionRoute, entries },
          target,
        );
    }
    const optionsKey = base + '/run-options/' + agentId;
    const options = z
      .object({ base: z.string(), selection: runSelectionSchema })
      .strict()
      .safeParse(composer ? byKey.get(optionsKey) : undefined);
    if (options.success) {
      recovered.selection = options.data.selection;
      covered.add(optionsKey);
    }
    const pending = mutationSchema.strict().safeParse(byKey.get(base + '/pending'));
    if (
      allowPending &&
      pending.success &&
      pending.data.workspaceId === target.workspaceId &&
      pending.data.sessionId === sessionId
    ) {
      recovered.pending = pending.data;
      covered.add(base + '/pending');
    }
    const wrapped = pendingPreviewMutationSchema.safeParse(byKey.get(base + '/pending'));
    const wrappedOriginal = mutationSchema
      .strict()
      .safeParse((byKey.get(base + '/pending') as { mutation?: unknown } | undefined)?.mutation);
    if (
      allowPending &&
      wrapped.success &&
      wrappedOriginal.success &&
      wrapped.data.mutation.workspaceId === target.workspaceId &&
      wrapped.data.mutation.sessionId === sessionId &&
      canonical(wrapped.data.annotationDelivery.submission.target) ===
        canonical(workspaceFeatureTarget({ ...target, sessionId }))
    ) {
      recovered.pending = wrappedOriginal.data;
      recovered.annotationDelivery = wrapped.data.annotationDelivery.submission;
      covered.add(base + '/pending');
    }
    if (!sessionId) {
      recovered.unresolvedKeys = records
        .filter(
          (item) =>
            item.value != null &&
            !covered.has(item.key) &&
            item.key !== base + '/draft/actor' &&
            composer &&
            item.key.startsWith(base + '/'),
        )
        .map((item) => item.key);
      return;
    }
    const metadataKey = sessionActionKey({ ...target, sessionId });
    const metadata = pendingSessionActionSchema.safeParse(byKey.get(metadataKey));
    if (
      metadata.success &&
      metadata.data.owner === target.owner &&
      metadata.data.deviceId === target.deviceId &&
      metadata.data.catalogWorkspaceId === target.catalogWorkspaceId &&
      metadata.data.replicaId === target.replicaId &&
      metadata.data.request.workspaceId === target.workspaceId &&
      metadata.data.request.localProjectId === target.localProjectId &&
      metadata.data.request.sessionId === sessionId
    ) {
      recovered.metadata = metadata.data;
      covered.add(metadataKey);
    }
    const attachmentScope = {
      owner: target.owner,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId,
    };
    const attachmentKey = attachmentDraftKey(attachmentScope);
    const attachments = attachmentDraftSchema.safeParse(byKey.get(attachmentKey));
    if (
      attachments.success &&
      Object.entries(attachmentScope).every(
        ([key, value]) => attachments.data.scope[key as keyof typeof attachmentScope] === value,
      ) &&
      attachments.data.items.every(
        (item) =>
          !item.pending ||
          (item.pending.owner === target.owner &&
            item.pending.deviceId === target.deviceId &&
            item.pending.catalogWorkspaceId === target.catalogWorkspaceId &&
            item.pending.replicaId === target.replicaId &&
            item.pending.request.workspaceId === target.workspaceId &&
            item.pending.request.localProjectId === target.localProjectId &&
            item.pending.request.sessionId === sessionId),
      )
    ) {
      recovered.attachments = attachments.data;
      covered.add(attachmentKey);
    }
    const extensionKeys = new Set(legacySessionExtensionKeys(target, sessionId));
    const interactionRecordKey = interactionKey(attachmentScope);
    const interactions = interactionSavedSchema.safeParse(byKey.get(interactionRecordKey));
    if (
      interactions.success &&
      [interactions.data.pending, ...interactions.data.closed.map((item) => item.operation)].every(
        (operation) =>
          !operation ||
          (interactionKey(interactionScope(operation)) === interactionRecordKey &&
            operation.catalogWorkspaceId === target.catalogWorkspaceId &&
            operation.replicaId === target.replicaId),
      )
    ) {
      recovered.interactions = interactions.data;
      covered.add(interactionRecordKey);
    }
    const mcpRecordKey = mcpKey({ ...target, sessionId });
    if (byKey.has(mcpRecordKey)) {
      try {
        const mcp = validateWorkspaceMcp(byKey.get(mcpRecordKey), { ...target, sessionId });
        if (
          !mcp.delivery ||
          (recovered.pending?.kind === 'turn' &&
            recovered.pending.operationId === mcp.delivery.operationId)
        ) {
          recovered.mcp = mcp;
          covered.add(mcpRecordKey);
        }
      } catch {
        /* Keep unsupported or mismatched records in the original partition. */
      }
    }
    const gitRecordKey = gitWorkspaceKey({ ...target, sessionId });
    if (byKey.has(gitRecordKey)) {
      try {
        recovered.git = validateWorkspaceGit(byKey.get(gitRecordKey), { ...target, sessionId });
        covered.add(gitRecordKey);
      } catch {
        /* Leave records whose original full identity cannot be confirmed. */
      }
    }
    const forkRecordKey = sessionForkKey({ ...target, sessionId });
    if (byKey.has(forkRecordKey)) {
      try {
        recovered.fork = validateWorkspaceFork(byKey.get(forkRecordKey), { ...target, sessionId });
        covered.add(forkRecordKey);
      } catch {
        /* Keep records without a verifiable original identity in place. */
      }
    }
    const githubRecordKey = githubKey({ ...target, sessionId });
    if (byKey.has(githubRecordKey)) {
      try {
        recovered.github = validateWorkspaceGithub(byKey.get(githubRecordKey), {
          ...target,
          sessionId,
        });
        covered.add(githubRecordKey);
      } catch {
        /* Unverified records remain unresolved. */
      }
    }
    const githubWriteRecordKey = githubWriteKey({ ...target, sessionId });
    if (byKey.has(githubWriteRecordKey)) {
      try {
        recovered.githubWrite = validateWorkspaceGithubWrite(byKey.get(githubWriteRecordKey), {
          ...target,
          sessionId,
        });
        covered.add(githubWriteRecordKey);
      } catch {
        /* Unverified records remain unresolved. */
      }
    }
    const rolesRecordKey = rolesKey({ ...target, sessionId });
    const tasksRecordKey = tasksKey({ ...target, sessionId });
    if (byKey.has(tasksRecordKey)) {
      try {
        const tasks = validateWorkspaceTasks(byKey.get(tasksRecordKey), { ...target, sessionId });
        if (
          !tasks.delivery ||
          (recovered.pending?.kind === 'turn' &&
            recovered.pending.operationId === tasks.delivery.operationId)
        ) {
          recovered.tasks = tasks;
          covered.add(tasksRecordKey);
        }
      } catch {
        /* Keep unverified plans and original grants in place. */
      }
    }
    if (byKey.has(rolesRecordKey)) {
      try {
        recovered.roles = validateWorkspaceRoles(byKey.get(rolesRecordKey), {
          ...target,
          sessionId,
        });
        covered.add(rolesRecordKey);
      } catch {
        /* Preserve unverified originals. */
      }
    }
    const appliedRecordKey = roleAppliedKey({ ...target, sessionId });
    if (byKey.has(appliedRecordKey)) {
      try {
        recovered.roleApplied = validateWorkspaceRoleApplied(byKey.get(appliedRecordKey), {
          ...target,
          sessionId,
        });
        covered.add(appliedRecordKey);
      } catch {
        /* Preserve unverified markers. */
      }
    }
    const previewRecordKey = projectPreviewKey(workspaceFeatureTarget({ ...target, sessionId }));
    if (byKey.has(previewRecordKey)) {
      try {
        recovered.preview = validateWorkspacePreview(byKey.get(previewRecordKey), {
          ...target,
          sessionId,
        });
        covered.add(previewRecordKey);
      } catch {
        /* Retain unverified original connection records. */
      }
    }
    const annotationsRecordKey = previewAnnotationKey(
      workspaceFeatureTarget({ ...target, sessionId }),
    );
    const annotations = previewAnnotationsStoredSchema.safeParse(byKey.get(annotationsRecordKey));
    if (
      annotations.success &&
      canonical(annotations.data.target) ===
        canonical(workspaceFeatureTarget({ ...target, sessionId }))
    ) {
      recovered.annotations = annotations.data;
      covered.add(annotationsRecordKey);
    }
    const contentTarget = sessionId
      ? {
          owner: target.owner,
          deviceId: target.deviceId,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          catalogWorkspaceId: target.catalogWorkspaceId,
          replicaId: target.replicaId,
          sessionId,
        }
      : undefined;
    const contentPrefixes = contentTarget
      ? [
          legacyContentPrefix(contentTarget, 'project-content-v1'),
          legacyContentPrefix(contentTarget, 'file-content-v1'),
        ]
      : [];
    for (const entry of records) {
      if (!contentTarget || !contentPrefixes.some((prefix) => entry.key.startsWith(prefix)))
        continue;
      try {
        parseLegacyContentEntry(entry, contentTarget);
        (recovered.content ??= []).push(entry);
        covered.add(entry.key);
      } catch {
        /* Unknown data remains in the original profile. */
      }
    }
    // Actor markers are not executable state. Everything else belonging to this
    // session must be understood before a recovered draft may become a new turn.
    recovered.unresolvedKeys = records
      .filter(
        (item) =>
          item.value != null &&
          !covered.has(item.key) &&
          item.key !== base + '/draft/actor' &&
          ((composer && item.key.startsWith(base + '/')) ||
            item.key === metadataKey ||
            extensionKeys.has(item.key) ||
            contentPrefixes.some((prefix) => item.key.startsWith(prefix)) ||
            (attentionSessionPrefix && item.key.startsWith(attentionSessionPrefix))),
      )
      .map((item) => item.key);
  }
  let newDraft: LegacyDraftRecovery | undefined;
  const newBase = prefix + 'new';
  const choices = z
    .object({ project: id, agent: id })
    .strict()
    .safeParse(byKey.get(newBase + '/options'));
  const attachmentSessionKey =
    'attachment-session-v1/' +
    JSON.stringify([target.owner, target.deviceId, target.workspaceId, target.localProjectId]);
  const reserved = id.safeParse(byKey.get(attachmentSessionKey));
  const rawPending = byKey.get(newBase + '/pending');
  const wrappedPending = pendingPreviewMutationSchema.safeParse(rawPending);
  const pending = mutationSchema
    .strict()
    .safeParse(wrappedPending.success ? wrappedPending.data.mutation : rawPending);
  let pendingMeta: z.infer<typeof sessionMetadataSchema> | undefined;
  if (
    pending.success &&
    pending.data.kind === 'turn' &&
    pending.data.workspaceId === target.workspaceId &&
    pending.data.metaBundle
  ) {
    try {
      const bundle = snapshotSchema.shape.metaBundle.parse(pending.data.metaBundle);
      const flock = Flock.fromJson(
        bundle as Parameters<typeof Flock.fromJson>[0],
        'moor-legacy-reader',
      );
      const candidate = sessionMetadataSchema.parse(
        metas(flock)['session-' + pending.data.sessionId],
      );
      if (
        candidate.id === pending.data.sessionId &&
        candidate.userId === target.userId &&
        candidate.machineId === target.machineId &&
        candidate.project.localProjectId === target.localProjectId
      )
        pendingMeta = candidate;
    } catch {
      /* An unreadable original remains in the old profile. */
    }
  }
  const selectedProject = choices.success && choices.data.project === target.localProjectId;
  // The old new/draft key is workspace-wide. Only the saved project choice or
  // the original first-turn metadata can bind it; an attachment alone cannot.
  if (selectedProject || pendingMeta || reserved.success) {
    const sessionId = pendingMeta
      ? pending.data!.sessionId
      : reserved.success
        ? reserved.data
        : undefined;
    {
      newDraft = {
        version: 1,
        kind: 'draft',
        scope,
        unresolvedKeys: [],
        ...(sessionId ? { sessionId } : {}),
        ...(pendingMeta
          ? { agentId: pendingMeta.agentConfigId }
          : selectedProject
            ? { agentId: choices.data!.agent }
            : {}),
      };
      if (selectedProject) covered.add(newBase + '/options');
      if (reserved.success && (!pendingMeta || reserved.data === sessionId))
        covered.add(attachmentSessionKey);
      recoverPayload(
        newDraft,
        newBase,
        sessionId,
        newDraft.agentId,
        !!pendingMeta,
        selectedProject,
      );
      // A pending first instruction is executable only with its original metadata;
      // project choices alone cannot bless an unrelated mutation.
      if (newDraft.pending && (!pendingMeta || newDraft.pending.sessionId !== sessionId)) {
        delete newDraft.pending;
        delete newDraft.annotationDelivery;
        covered.delete(newBase + '/pending');
        if (!newDraft.unresolvedKeys.includes(newBase + '/pending'))
          newDraft.unresolvedKeys.push(newBase + '/pending');
      }
      if (
        rawPending != null &&
        !pendingMeta &&
        selectedProject &&
        !newDraft.unresolvedKeys.includes(newBase + '/pending')
      )
        newDraft.unresolvedKeys.push(newBase + '/pending');
      if (
        !newDraft.draft &&
        !newDraft.pending &&
        !newDraft.attachments?.items.length &&
        !newDraft.unresolvedKeys.length &&
        !newDraft.git &&
        !newDraft.mcp &&
        !newDraft.tasks &&
        !newDraft.preview &&
        !newDraft.annotations &&
        !newDraft.roles &&
        !newDraft.fork &&
        !newDraft.github &&
        !newDraft.githubWrite
      )
        newDraft = undefined;
    }
  }
  const unassigned = byKey.get(newBase + '/draft');
  const unassignedDraft =
    !covered.has(newBase + '/draft') &&
    typeof unassigned === 'string' &&
    unassigned.length > 0 &&
    unassigned.length <= 100000
      ? unassigned
      : undefined;
  if (unassignedDraft !== undefined) covered.add(newBase + '/draft');
  // Unrecognized data stays in the original profile. It is never guessed into this project.
  return legacyCacheRecoverySchema.parse({
    version: 1,
    scope,
    ...(selection ? { selection } : {}),
    sessions,
    ...(newDraft ? { newDraft } : {}),
    ...(unassignedDraft === undefined ? {} : { unassignedDraft }),
    unresolved: records.filter((record) => record.value != null && !covered.has(record.key)).length,
  });
}
