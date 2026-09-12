import { z } from 'zod';
import { id } from './protocol';
import {
  CONTENT_LIMITS,
  CONTENT_VERSION,
  contentScopeSchema,
  contentVersionSchema,
  projectFilePathSchema,
} from './content-protocol';

export const PROJECT_TREE_FEATURE = 'project-tree-v1';
export const PROJECT_DIFF_FEATURE = 'project-diff-v1';
export const projectContentIssueSchema = z
  .object({
    reason: z.enum([
      'policy-excluded',
      'git-unavailable',
      'git-failed',
      'directory-ignore-unavailable',
      'invalid-path',
      'symlink',
      'nonregular',
      'unavailable',
      'changed',
      'entry-limit',
      'depth-limit',
      'oversize',
      'read-budget',
      'change-limit',
      'incomplete-baseline',
      'enumeration-changed',
      'issue-limit',
      'capture-failed',
      'scope-changed',
      'interrupted',
      'not-recorded',
      'persistence-failed',
    ]),
    path: projectFilePathSchema.optional(),
    count: z.number().int().positive().optional(),
  })
  .strict();
const base = contentScopeSchema.extend({ contentVersion: z.literal(CONTENT_VERSION) });
export const projectTreeReadSchema = base
  .extend({
    offset: z.number().int().min(0).max(5000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    knownVersion: contentVersionSchema.optional(),
  })
  .strict()
  .refine((value) => !value.offset || !!value.knownVersion, '后续文件树分页必须绑定版本');
export const projectTreeEntrySchema = z
  .object({
    path: projectFilePathSchema,
    type: z.enum(['file', 'directory']),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((value) => value.type !== 'directory' || value.size === 0, '目录大小必须为零');
export const projectTreeResultSchema = base
  .extend({
    confirmed: z.literal(true),
    version: contentVersionSchema,
    source: z.enum(['git', 'directory']),
    entries: z.array(projectTreeEntrySchema).max(500),
    offset: z.number().int().nonnegative(),
    total: z.number().int().min(0).max(5000),
    nextOffset: z.number().int().positive().max(5000).optional(),
    partial: z.boolean(),
    enumerationComplete: z.boolean(),
    issues: z.array(projectContentIssueSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.path)).size === value.entries.length &&
      value.offset + value.entries.length <= value.total &&
      (value.offset + value.entries.length < value.total
        ? value.nextOffset === value.offset + value.entries.length && value.entries.length > 0
        : value.nextOffset === undefined),
    '文件树分页或路径重复',
  );
export const projectDiffStateSchema = z.enum([
  'pending',
  'ready',
  'partial',
  'unavailable',
  'interrupted',
]);
// Only this small reference belongs in the shared session document. Historical
// file bodies and snapshots stay in scoped host tables.
export const projectDiffReferenceSchema = z
  .object({
    contentVersion: z.literal(CONTENT_VERSION),
    basis: z.literal('project-snapshot'),
    turnId: id,
    diffId: id,
    state: projectDiffStateSchema,
    version: contentVersionSchema.optional(),
    changeCount: z.number().int().min(0).max(CONTENT_LIMITS.diffFiles),
  })
  .strict()
  .refine(
    (value) =>
      value.state === 'pending'
        ? value.version === undefined && value.changeCount === 0
        : !['ready', 'partial'].includes(value.state) || !!value.version,
    '文件变更引用状态无效',
  );
const snapshotFileBase = z
  .object({
    path: projectFilePathSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['text', 'binary', 'oversize', 'unavailable']),
    version: contentVersionSchema.optional(),
    mediaType: z.enum(['text/plain', 'application/octet-stream']).optional(),
  })
  .strict();
function validSnapshotFile(value: z.infer<typeof snapshotFileBase>) {
  if (value.state === 'text' || value.state === 'binary')
    return (
      value.size <= CONTENT_LIMITS.fileBytes &&
      !!value.version &&
      value.mediaType === (value.state === 'text' ? 'text/plain' : 'application/octet-stream')
    );
  return (
    !value.version &&
    !value.mediaType &&
    (value.state !== 'oversize' || value.size > CONTENT_LIMITS.fileBytes)
  );
}
export const projectSnapshotFileSummarySchema = snapshotFileBase.refine(
  validSnapshotFile,
  '文件基线状态与摘要不匹配',
);
export const projectDiffChangeSchema = z
  .object({
    path: projectFilePathSchema,
    previousPath: projectFilePathSchema.optional(),
    kind: z.enum(['added', 'deleted', 'modified', 'renamed']),
    before: projectSnapshotFileSummarySchema.nullable(),
    after: projectSnapshotFileSummarySchema.nullable(),
  })
  .strict()
  .refine((value) => {
    if (value.after && value.after.path !== value.path) return false;
    if (value.kind === 'added') return !value.before && !!value.after && !value.previousPath;
    if (value.kind === 'deleted')
      return (
        !!value.before && !value.after && value.before.path === value.path && !value.previousPath
      );
    if (!value.before || !value.after) return false;
    if (value.kind === 'renamed')
      return (
        !!value.previousPath &&
        value.previousPath !== value.path &&
        value.before.path === value.previousPath &&
        !!value.before.version &&
        value.before.version === value.after.version
      );
    return !value.previousPath && value.before.path === value.path;
  }, '文件变化类型与前后基线不匹配');
export const projectTurnDiffReadSchema = base.extend({ turnId: id }).strict();
export const projectTurnDiffResultSchema = base
  .extend({
    confirmed: z.literal(true),
    turnId: id,
    state: z.enum(['pending', 'ready', 'partial', 'unavailable', 'interrupted', 'not-recorded']),
    reference: projectDiffReferenceSchema.optional(),
    changes: z.array(projectDiffChangeSchema).max(CONTENT_LIMITS.diffFiles),
    partial: z.boolean(),
    issues: z.array(projectContentIssueSchema).max(100),
    attribution: z.literal('shared-project'),
  })
  .strict()
  .refine(
    (value) =>
      value.state === 'not-recorded'
        ? !value.reference && value.changes.length === 0 && value.partial
        : !!value.reference &&
          value.reference.turnId === value.turnId &&
          value.reference.state === value.state &&
          value.reference.changeCount === value.changes.length &&
          (['pending', 'unavailable', 'interrupted'].includes(value.state)
            ? value.changes.length === 0 && value.partial
            : true),
    '回合变更状态或引用不匹配',
  )
  .refine(
    (value) =>
      value.state === 'ready' ? !value.partial && value.issues.length === 0 : value.partial,
    '部分结果状态不匹配',
  )
  .refine(
    (value) =>
      new Set(value.changes.map((change) => change.path)).size === value.changes.length &&
      new Set(value.changes.filter((change) => change.before).map((change) => change.before!.path))
        .size === value.changes.filter((change) => change.before).length,
    '文件变更路径重复',
  );
export const projectDiffFileReadSchema = projectTurnDiffReadSchema
  .extend({ path: projectFilePathSchema, knownVersion: contentVersionSchema.optional() })
  .strict();
export const projectSnapshotFileContentSchema = snapshotFileBase
  .extend({ text: z.string().max(CONTENT_LIMITS.fileBytes).optional() })
  .strict()
  .refine(validSnapshotFile, '文件基线状态与摘要不匹配')
  .refine(
    (value) =>
      value.state === 'text'
        ? typeof value.text === 'string' &&
          !!value.version &&
          value.mediaType === 'text/plain' &&
          new TextEncoder().encode(value.text).byteLength === value.size
        : value.text === undefined,
    '历史文件正文与摘要不匹配',
  );
export const projectDiffFileResultSchema = base
  .extend({
    confirmed: z.literal(true),
    turnId: id,
    path: projectFilePathSchema,
    reference: projectDiffReferenceSchema,
    before: projectSnapshotFileContentSchema.nullable(),
    after: projectSnapshotFileContentSchema.nullable(),
    partial: z.boolean(),
    issues: z.array(projectContentIssueSchema).max(100),
    attribution: z.literal('shared-project'),
  })
  .strict()
  .refine(
    (value) =>
      value.reference.turnId === value.turnId &&
      ['ready', 'partial'].includes(value.reference.state) &&
      !!(value.before || value.after) &&
      (!value.after || value.after.path === value.path) &&
      (!!value.after || value.before?.path === value.path) &&
      (value.reference.state === 'ready'
        ? !value.partial && value.issues.length === 0
        : value.partial),
    '历史文件回合或路径不匹配',
  );
export type ProjectContentIssue = z.infer<typeof projectContentIssueSchema>;
export type ProjectTreeRead = z.infer<typeof projectTreeReadSchema>;
export type ProjectTreeResult = z.infer<typeof projectTreeResultSchema>;
export type ProjectDiffReference = z.infer<typeof projectDiffReferenceSchema>;
export type ProjectSnapshotFileSummary = z.infer<typeof projectSnapshotFileSummarySchema>;
export type ProjectDiffChange = z.infer<typeof projectDiffChangeSchema>;
export type ProjectTurnDiffRead = z.infer<typeof projectTurnDiffReadSchema>;
export type ProjectTurnDiffResult = z.infer<typeof projectTurnDiffResultSchema>;
export type ProjectDiffFileRead = z.infer<typeof projectDiffFileReadSchema>;
export type ProjectDiffFileResult = z.infer<typeof projectDiffFileResultSchema>;
