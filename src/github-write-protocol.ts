import { z } from 'zod';
import { id } from './protocol';
import {
  contentScopeSchema,
  contentVersionSchema,
  projectFilePathSchema,
} from './content-protocol';
import {
  gitBranchSchema,
  gitOidSchema,
  gitRepositoryStateSchema,
  sessionExecutionSchema,
} from './git-protocol';
import {
  githubRepositorySchema,
  githubNumberSchema,
  githubPageNumberSchema,
  githubPageSchema,
  githubBranchSchema,
  githubCommentSchema,
} from './github-protocol';

export const GITHUB_WRITE_FEATURE = 'github-write-v1';
export const GITHUB_WRITE_LIMITS = { body: 12000, patch: 65536, files: 50, message: 8000 } as const;
const scope = contentScopeSchema.extend({ githubWriteVersion: z.literal(1) });
const branch = gitBranchSchema;
const version = contentVersionSchema;
const line = z.number().int().positive().max(10000000);
export const githubReviewSideSchema = z.enum(['LEFT', 'RIGHT']);
export const githubPullFileSchema = z
  .object({
    path: projectFilePathSchema,
    previousPath: projectFilePathSchema.optional(),
    sha: gitOidSchema,
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    additions: z.number().int().nonnegative().safe(),
    deletions: z.number().int().nonnegative().safe(),
    changes: z.number().int().nonnegative().safe(),
    patch: z.string().max(GITHUB_WRITE_LIMITS.patch).optional(),
    patchTruncated: z.boolean(),
    version,
  })
  .strict();
export type GithubPullFile = z.infer<typeof githubPullFileSchema>;
export const githubReviewCommentSchema = githubCommentSchema
  .extend({
    path: projectFilePathSchema,
    commitSha: gitOidSchema,
    originalCommitSha: gitOidSchema,
    side: githubReviewSideSchema,
    line: line.nullable(),
    originalLine: line.nullable(),
    startLine: line.nullable().optional(),
    startSide: githubReviewSideSchema.nullable().optional(),
    replyTo: githubNumberSchema.optional(),
    version,
  })
  .strict();
export type GithubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export const gitCommitAuthorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^<>\r\n\u0000-\u001f\u007f]+$/),
    email: z.string().email().max(200),
  })
  .strict();
export const gitCommitFileSchema = z
  .object({
    path: projectFilePathSchema,
    kind: z.enum(['add', 'modify', 'delete']),
    version,
    byteLength: z.number().int().nonnegative().safe(),
    mode: z.enum(['100644', '100755']).nullable(),
    beforeText: z.string().max(16000).optional(),
    afterText: z.string().max(16000).optional(),
    binary: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
const paths = z
  .array(projectFilePathSchema)
  .min(1)
  .max(GITHUB_WRITE_LIMITS.files)
  .refine((v) => new Set(v).size === v.length, '重复文件路径');
const remote = z.object({ repositoryId: githubNumberSchema, configVersion: version });
const remoteRead = scope.merge(remote);
export const githubWriteReadSchema = z.discriminatedUnion('view', [
  scope.extend({ view: z.literal('overview') }).strict(),
  scope.extend({ view: z.literal('commit-preview'), paths }).strict(),
  remoteRead.extend({ view: z.literal('branches'), page: githubPageNumberSchema }).strict(),
  remoteRead
    .extend({
      view: z.literal('files'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      page: githubPageNumberSchema,
    })
    .strict(),
  remoteRead
    .extend({
      view: z.literal('review-comments'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      page: githubPageNumberSchema,
    })
    .strict(),
  remoteRead.extend({ view: z.literal('push-preview'), branch, headOid: gitOidSchema }).strict(),
]);
export type GithubWriteRead = z.infer<typeof githubWriteReadSchema>;
const readResponse = scope.extend({ confirmed: z.literal(true), readAt: z.string().datetime() });
const remoteResponse = readResponse.extend({
  repository: githubRepositorySchema,
  configVersion: version,
  writesEnabled: z.boolean(),
  bindingRevision: z.number().int().nonnegative().safe(),
});
export const githubWriteReadResultSchema = z.discriminatedUnion('view', [
  readResponse
    .extend({
      view: z.literal('overview'),
      repository: githubRepositorySchema.optional(),
      configVersion: version.optional(),
      writesEnabled: z.boolean(),
      bindingRevision: z.number().int().nonnegative().safe(),
      reason: z.string().max(1000).optional(),
      git: gitRepositoryStateSchema,
      execution: sessionExecutionSchema,
      canCommit: z.boolean(),
    })
    .strict(),
  readResponse
    .extend({
      view: z.literal('commit-preview'),
      candidateVersion: version,
      branch,
      parentOid: gitOidSchema,
      indexVersion: version,
      files: z.array(gitCommitFileSchema).min(1).max(GITHUB_WRITE_LIMITS.files),
      execution: sessionExecutionSchema,
    })
    .strict(),
  remoteResponse
    .extend({ view: z.literal('branches'), result: githubPageSchema(githubBranchSchema) })
    .strict(),
  remoteResponse
    .extend({
      view: z.literal('files'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      result: githubPageSchema(githubPullFileSchema),
    })
    .strict(),
  remoteResponse
    .extend({
      view: z.literal('review-comments'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      result: githubPageSchema(githubReviewCommentSchema),
    })
    .strict(),
  remoteResponse
    .extend({
      view: z.literal('push-preview'),
      branch,
      headOid: gitOidSchema,
      expectedRemoteOid: gitOidSchema.nullable(),
      canPush: z.boolean(),
      reason: z.string().max(1000).optional(),
      execution: sessionExecutionSchema,
    })
    .strict(),
]);
export type GithubWriteReadResult = z.infer<typeof githubWriteReadResultSchema>;
const action = scope.extend({ operationId: id, confirmed: z.literal(true) });
const remoteAction = action
  .merge(remote)
  .extend({ expectedBindingRevision: z.number().int().nonnegative().safe() });
const body = z
  .string()
  .max(GITHUB_WRITE_LIMITS.body)
  .refine((v) => !v.includes('\0'));
const commentBody = body.refine((v) => v.trim().length > 0, '评论不能为空');
const title = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\r\n\u0000-\u001f\u007f]+$/);
const pullAction = remoteAction.extend({
  number: githubNumberSchema,
  expectedVersion: version,
  headSha: gitOidSchema,
});
export const githubWriteActionSchema = z.discriminatedUnion('action', [
  remoteAction
    .extend({
      action: z.literal('issue-comment'),
      subject: z.enum(['issue', 'pull']),
      number: githubNumberSchema,
      expectedVersion: version,
      body: commentBody,
    })
    .strict(),
  remoteAction
    .extend({
      action: z.literal('review-comment'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      filePage: githubPageNumberSchema,
      path: projectFilePathSchema,
      fileVersion: version,
      side: githubReviewSideSchema,
      line,
      body: commentBody,
    })
    .strict(),
  remoteAction
    .extend({
      action: z.literal('review-reply'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      commentId: githubNumberSchema,
      commentVersion: version,
      body: commentBody,
    })
    .strict(),
  remoteAction
    .extend({
      action: z.literal('pr-create'),
      headBranch: branch,
      baseBranch: branch,
      headSha: gitOidSchema,
      baseSha: gitOidSchema,
      title,
      body,
      draft: z.boolean(),
    })
    .strict(),
  pullAction.extend({ action: z.literal('pr-update'), title, body }).strict(),
  pullAction.extend({ action: z.literal('pr-state'), state: z.enum(['open', 'closed']) }).strict(),
  pullAction
    .extend({ action: z.literal('pr-merge'), method: z.enum(['merge', 'squash', 'rebase']) })
    .strict(),
  action
    .extend({
      action: z.literal('commit'),
      paths,
      candidateVersion: version,
      branch,
      parentOid: gitOidSchema,
      indexVersion: version,
      executionRevision: z.number().int().nonnegative().safe(),
      message: z
        .string()
        .trim()
        .min(1)
        .max(GITHUB_WRITE_LIMITS.message)
        .refine((v) => !v.includes('\0')),
      author: gitCommitAuthorSchema,
    })
    .strict(),
  remoteAction
    .extend({
      action: z.literal('push'),
      branch,
      headOid: gitOidSchema,
      expectedRemoteOid: gitOidSchema.nullable(),
      executionRevision: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
export type GithubWriteAction = z.infer<typeof githubWriteActionSchema>;
export const githubWriteInspectSchema = z
  .object({ request: githubWriteActionSchema, page: githubPageNumberSchema })
  .strict();
export type GithubWriteInspect = z.infer<typeof githubWriteInspectSchema>;
export const githubWriteAbandonSchema = z.object({ request: githubWriteActionSchema }).strict();
export const githubWriteOutcomeSchema = z
  .object({
    id: githubNumberSchema.optional(),
    number: githubNumberSchema.optional(),
    sha: gitOidSchema.optional(),
  })
  .strict();
export type GithubWriteOutcome = z.infer<typeof githubWriteOutcomeSchema>;
export const githubWriteReceiptSchema = scope
  .extend({
    operationId: id,
    action: z.enum([
      'issue-comment',
      'review-comment',
      'review-reply',
      'pr-create',
      'pr-update',
      'pr-state',
      'pr-merge',
      'commit',
      'push',
    ]),
    requestVersion: version,
    phase: z.enum(['accepted', 'rejected', 'unknown', 'abandoned']),
    confirmed: z.boolean(),
    result: githubWriteOutcomeSchema.optional(),
    released: z.literal(true).optional(),
    message: z.string().max(1000),
    checkedAt: z.string().datetime(),
  })
  .strict()
  .refine((v) => v.confirmed === (v.phase === 'accepted') && (!v.released || v.phase === 'unknown'))
  .refine((v) => {
    if (v.phase === 'abandoned' || v.phase === 'rejected') return v.result === undefined;
    if (v.phase !== 'accepted') return true;
    if (v.action === 'commit' || v.action === 'push') return v.result?.sha !== undefined;
    if (v.action === 'pr-merge') return v.result?.number !== undefined;
    return v.result?.id !== undefined && v.result.number !== undefined;
  }, '已确认的写入必须包含可核查的结果身份');
export type GithubWriteReceipt = z.infer<typeof githubWriteReceiptSchema>;

/** A patch's actual line map, shared by selection UI and host authorization. */
export function githubPatchLines(file: Pick<GithubPullFile, 'patch' | 'patchTruncated'>): {
  text: string;
  kind: 'header' | 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
}[] {
  if (!file.patch || file.patchTruncated) return [];
  const result: ReturnType<typeof githubPatchLines> = [];
  let old = 0,
    next = 0,
    oldRemaining = 0,
    nextRemaining = 0,
    hunk = false;
  for (const row of file.patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
    if (match) {
      if (hunk && (oldRemaining !== 0 || nextRemaining !== 0)) return [];
      old = Number(match[1]);
      next = Number(match[3]);
      oldRemaining = Number(match[2] ?? 1);
      nextRemaining = Number(match[4] ?? 1);
      hunk = true;
      if (
        ![old, next, oldRemaining, nextRemaining].every(
          (v) => Number.isSafeInteger(v) && v >= 0 && v <= 10000000,
        )
      )
        return [];
      result.push({ text: row, kind: 'header' });
      continue;
    }
    if (row === '\\ No newline at end of file') {
      result.push({ text: row, kind: 'header' });
      continue;
    }
    if (!hunk) return [];
    if (row === '' && oldRemaining === 0 && nextRemaining === 0) continue;
    const type = row[0];
    if (type === ' ' && oldRemaining > 0 && nextRemaining > 0) {
      result.push({ text: row.slice(1), kind: 'context', oldLine: old++, newLine: next++ });
      oldRemaining--;
      nextRemaining--;
    } else if (type === '-' && oldRemaining > 0) {
      result.push({ text: row.slice(1), kind: 'remove', oldLine: old++ });
      oldRemaining--;
    } else if (type === '+' && nextRemaining > 0) {
      result.push({ text: row.slice(1), kind: 'add', newLine: next++ });
      nextRemaining--;
    } else return [];
  }
  return hunk && oldRemaining === 0 && nextRemaining === 0 ? result : [];
}
