import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema, contentVersionSchema } from './content-protocol';
import { gitBranchSchema, gitOidSchema, sessionExecutionSchema } from './git-protocol';

export const GITHUB_FEATURE = 'github-read-v1';
export const GITHUB_LIMITS = { pageSize: 20, pages: 100, bodyChars: 16000, title: 500 } as const;
export const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
export const githubRepoNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((v) => v !== '.' && v !== '..');
export const githubNumberSchema = z.number().int().positive().safe();
export const githubPageNumberSchema = z.number().int().min(1).max(GITHUB_LIMITS.pages);
export const githubUrlSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === 'https:' &&
        u.hostname === 'github.com' &&
        !u.username &&
        !u.password &&
        !u.port &&
        !u.search &&
        !/[\\\u0000-\u001f\u007f]/.test(value)
      );
    } catch {
      return false;
    }
  });
export const githubRepositoryRefSchema = z
  .object({ id: githubNumberSchema, owner: githubOwnerSchema, name: githubRepoNameSchema })
  .strict();
export type GithubRepositoryRef = z.infer<typeof githubRepositoryRefSchema>;
export const githubRepositorySchema = githubRepositoryRefSchema
  .extend({ defaultBranch: gitBranchSchema, private: z.boolean(), url: githubUrlSchema })
  .strict();
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export const githubBranchSchema = z
  .object({ name: gitBranchSchema, sha: gitOidSchema, protected: z.boolean() })
  .strict();
export type GithubBranch = z.infer<typeof githubBranchSchema>;
const itemBase = z
  .object({
    id: githubNumberSchema,
    number: githubNumberSchema,
    title: z.string().max(GITHUB_LIMITS.title),
    state: z.enum(['open', 'closed', 'merged']),
    author: z.string().max(100),
    url: githubUrlSchema,
    updatedAt: z.string().datetime(),
    draft: z.boolean().optional(),
  })
  .strict();
export const githubItemSummarySchema = itemBase
  .extend({ kind: z.enum(['issue', 'pull']) })
  .strict();
export type GithubItemSummary = z.infer<typeof githubItemSummarySchema>;
const detail = itemBase.extend({
  body: z.string().max(GITHUB_LIMITS.bodyChars),
  bodyTruncated: z.boolean(),
  labels: z.array(z.string().max(100)).max(50),
  version: contentVersionSchema,
});
export const githubIssueSchema = detail.extend({ kind: z.literal('issue') }).strict();
export type GithubIssue = z.infer<typeof githubIssueSchema>;
export const githubPullSchema = detail
  .extend({
    kind: z.literal('pull'),
    head: z
      .object({
        sha: gitOidSchema,
        branch: gitBranchSchema,
        repository: githubRepositoryRefSchema.nullable(),
      })
      .strict(),
    base: z
      .object({ sha: gitOidSchema, branch: gitBranchSchema, repository: githubRepositoryRefSchema })
      .strict(),
    mergeable: z.boolean().nullable(),
  })
  .strict();
export type GithubPull = z.infer<typeof githubPullSchema>;
export const githubCommentSchema = z
  .object({
    id: githubNumberSchema,
    author: z.string().max(100),
    body: z.string().max(GITHUB_LIMITS.bodyChars),
    bodyTruncated: z.boolean(),
    url: githubUrlSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type GithubComment = z.infer<typeof githubCommentSchema>;
export const githubCheckSchema = z
  .object({
    id: githubNumberSchema,
    name: z.string().max(300),
    status: z.string().max(100),
    conclusion: z.string().max(100).nullable(),
    url: githubUrlSchema.optional(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type GithubCheck = z.infer<typeof githubCheckSchema>;
export const githubStatusSchema = z
  .object({
    id: githubNumberSchema,
    context: z.string().max(300),
    state: z.enum(['error', 'failure', 'pending', 'success']),
    description: z.string().max(1000).nullable(),
    url: githubUrlSchema.optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type GithubStatus = z.infer<typeof githubStatusSchema>;
export function githubPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item).max(GITHUB_LIMITS.pageSize),
      page: githubPageNumberSchema,
      hasNext: z.boolean(),
      partial: z.boolean(),
    })
    .strict();
}
export type GithubPage<T> = { items: T[]; page: number; hasNext: boolean; partial: boolean };
export const githubChecksPageSchema = githubPageSchema(githubCheckSchema);
export const githubStatusesPageSchema = githubPageSchema(githubStatusSchema)
  .extend({
    state: z.enum(['failure', 'pending', 'success']),
    totalCount: z.number().int().nonnegative().safe(),
  })
  .strict();
export type GithubStatusesPage = z.infer<typeof githubStatusesPageSchema>;
export const githubSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('issue'), number: githubNumberSchema, version: contentVersionSchema })
    .strict(),
  z
    .object({
      kind: z.literal('pull'),
      number: githubNumberSchema,
      version: contentVersionSchema,
      headSha: gitOidSchema,
    })
    .strict(),
]);
export type GithubSubject = z.infer<typeof githubSubjectSchema>;
export const githubBindingContextSchema = z
  .object({
    repository: githubRepositoryRefSchema,
    branch: gitBranchSchema,
    subject: githubSubjectSchema.nullable(),
    headRepository: githubRepositoryRefSchema.nullable().optional(),
    baseBranch: gitBranchSchema.optional(),
    baseSha: gitOidSchema.optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const githubBindingSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    context: githubBindingContextSchema.optional(),
  })
  .strict();
export type GithubBinding = z.infer<typeof githubBindingSchema>;
const scope = contentScopeSchema.extend({ githubVersion: z.literal(1) });
const read = scope.extend({
  repositoryId: githubNumberSchema,
  configVersion: contentVersionSchema,
});
const list = read.extend({
  page: githubPageNumberSchema,
  state: z.enum(['open', 'closed', 'all']),
});
export const githubReadSchema = z.discriminatedUnion('view', [
  scope.extend({ view: z.literal('overview') }).strict(),
  read.extend({ view: z.literal('branches'), page: githubPageNumberSchema }).strict(),
  list.extend({ view: z.literal('issues') }).strict(),
  list.extend({ view: z.literal('pulls') }).strict(),
  read.extend({ view: z.literal('issue'), number: githubNumberSchema }).strict(),
  read.extend({ view: z.literal('pull'), number: githubNumberSchema }).strict(),
  read
    .extend({
      view: z.literal('comments'),
      number: githubNumberSchema,
      subject: z.enum(['issue', 'pull']),
      page: githubPageNumberSchema,
    })
    .strict(),
  read
    .extend({
      view: z.literal('checks'),
      number: githubNumberSchema,
      headSha: gitOidSchema,
      page: githubPageNumberSchema,
    })
    .strict(),
]);
export type GithubRead = z.infer<typeof githubReadSchema>;
const response = scope.extend({
  confirmed: z.literal(true),
  repository: githubRepositorySchema,
  configVersion: contentVersionSchema,
  binding: githubBindingSchema,
  readAt: z.string().datetime(),
});
export const githubReadResultSchema = z
  .discriminatedUnion('view', [
    scope
      .extend({
        view: z.literal('overview'),
        confirmed: z.literal(true),
        status: z.enum(['available', 'unavailable']),
        repository: githubRepositorySchema.optional(),
        configVersion: contentVersionSchema.optional(),
        binding: githubBindingSchema,
        localBranch: gitBranchSchema.optional(),
        localHeadSha: gitOidSchema.optional(),
        execution: sessionExecutionSchema.optional(),
        reason: z.string().max(1000).optional(),
        readAt: z.string().datetime(),
      })
      .strict(),
    response
      .extend({ view: z.literal('branches'), result: githubPageSchema(githubBranchSchema) })
      .strict(),
    response
      .extend({
        view: z.literal('issues'),
        state: z.enum(['open', 'closed', 'all']),
        result: githubPageSchema(githubItemSummarySchema),
      })
      .strict(),
    response
      .extend({
        view: z.literal('pulls'),
        state: z.enum(['open', 'closed', 'all']),
        result: githubPageSchema(githubItemSummarySchema),
      })
      .strict(),
    response.extend({ view: z.literal('issue'), item: githubIssueSchema }).strict(),
    response.extend({ view: z.literal('pull'), item: githubPullSchema }).strict(),
    response
      .extend({
        view: z.literal('comments'),
        number: githubNumberSchema,
        subject: z.enum(['issue', 'pull']),
        result: githubPageSchema(githubCommentSchema),
      })
      .strict(),
    response
      .extend({
        view: z.literal('checks'),
        number: githubNumberSchema,
        headSha: gitOidSchema,
        checks: githubChecksPageSchema,
        statuses: githubStatusesPageSchema,
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    if (
      v.view === 'overview' &&
      ((v.status === 'available' && (!v.repository || !v.configVersion)) ||
        (v.status === 'unavailable' && (v.repository || v.configVersion || v.binding.context)))
    )
      ctx.addIssue({ code: 'custom', message: 'GitHub 授权状态与内容不匹配' });
    const context = v.binding.context;
    if (
      context &&
      (!v.repository ||
        context.repository.id !== v.repository.id ||
        context.repository.owner.toLowerCase() !== v.repository.owner.toLowerCase() ||
        context.repository.name.toLowerCase() !== v.repository.name.toLowerCase())
    )
      ctx.addIssue({ code: 'custom', message: '会话关联不属于已授权仓库' });
    if (
      v.view === 'pull' &&
      (v.item.base.repository.id !== v.repository.id ||
        v.item.base.repository.owner.toLowerCase() !== v.repository.owner.toLowerCase() ||
        v.item.base.repository.name.toLowerCase() !== v.repository.name.toLowerCase())
    )
      ctx.addIssue({ code: 'custom', message: 'PR 目标不属于已授权仓库' });
  });
export type GithubReadResult = z.infer<typeof githubReadResultSchema>;
const action = scope.extend({
  operationId: id,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
export const githubActionSchema = z.discriminatedUnion('action', [
  action
    .extend({
      action: z.literal('bind'),
      repositoryId: githubNumberSchema,
      configVersion: contentVersionSchema,
      branch: gitBranchSchema,
      subject: githubSubjectSchema.nullable(),
    })
    .strict(),
  action.extend({ action: z.literal('unbind') }).strict(),
]);
export type GithubAction = z.infer<typeof githubActionSchema>;
export const githubReceiptSchema = scope
  .extend({
    operationId: id,
    confirmed: z.literal(true),
    binding: githubBindingSchema,
    redacted: z.literal(true).optional(),
    abandoned: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => !(v.redacted && v.abandoned) && (!(v.redacted || v.abandoned) || !v.binding.context),
    '历史或未执行确认不能包含 GitHub 上下文',
  );
export type GithubReceipt = z.infer<typeof githubReceiptSchema>;
