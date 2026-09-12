import { z } from 'zod';
import { id } from './protocol';
import {
  contentScopeSchema,
  contentVersionSchema,
  projectFilePathSchema,
} from './content-protocol';

export const SKILLS_FEATURE = 'skills-read-v1';
export const SKILLS_LIMITS = {
  fileBytes: 64 * 1024,
  items: 200,
  entries: 2000,
  depth: 4,
  globalSources: 20,
  issues: 100,
  concurrentReads: 2,
} as const;
const label = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
export const skillSourceSchema = z
  .object({
    id,
    label,
    scope: z.enum(['project', 'global']),
    convention: z.enum(['agents', 'claude', 'codex', 'registered']),
    version: contentVersionSchema,
    status: z.enum(['available', 'missing', 'unavailable']),
  })
  .strict();
export const skillSummarySchema = z
  .object({
    id,
    sourceId: id,
    path: projectFilePathSchema.refine((v) => v.endsWith('/SKILL.md')),
    name: label,
    description: z.string().max(2000),
    version: contentVersionSchema,
    byteLength: z.number().int().nonnegative().max(SKILLS_LIMITS.fileBytes),
    metadata: z.enum(['parsed', 'unparsed']),
  })
  .strict();
export const skillIssueSchema = z
  .object({
    sourceId: id,
    path: projectFilePathSchema.optional(),
    reason: z.enum(['unreadable', 'invalid-text', 'too-large', 'limit', 'unsupported-entry']),
  })
  .strict();
const base = contentScopeSchema.extend({ skillsVersion: z.literal(1) });
export const skillsReadSchema = z.discriminatedUnion('view', [
  base.extend({ view: z.literal('list') }).strict(),
  base
    .extend({
      view: z.literal('detail'),
      sourceId: id,
      skillId: id,
      version: contentVersionSchema,
      catalogVersion: contentVersionSchema,
      executionRevision: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
const resultBase = base.extend({
  catalogVersion: contentVersionSchema,
  executionRevision: z.number().int().nonnegative().safe(),
  confirmed: z.literal(true),
});
export const skillsReadResultSchema = z.discriminatedUnion('view', [
  resultBase
    .extend({
      view: z.literal('list'),
      sources: z.array(skillSourceSchema).max(SKILLS_LIMITS.globalSources + 3),
      skills: z.array(skillSummarySchema).max(SKILLS_LIMITS.items),
      issues: z.array(skillIssueSchema).max(SKILLS_LIMITS.issues),
      truncated: z.boolean(),
    })
    .strict(),
  resultBase
    .extend({
      view: z.literal('detail'),
      source: skillSourceSchema,
      skill: skillSummarySchema,
      text: z.string().max(SKILLS_LIMITS.fileBytes),
    })
    .strict(),
]);
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillIssue = z.infer<typeof skillIssueSchema>;
export type SkillsRead = z.infer<typeof skillsReadSchema>;
export type SkillsReadResult = z.infer<typeof skillsReadResultSchema>;
export type SkillsList = Extract<SkillsReadResult, { view: 'list' }>;
export type SkillDetail = Extract<SkillsReadResult, { view: 'detail' }>;

/** Wire identity checks shared by relay and browser; text digest is checked separately. */
export function validateSkillsRead(value: unknown, request: SkillsRead): SkillsReadResult {
  const result = skillsReadResultSchema.parse(value);
  if (
    result.workspaceId !== request.workspaceId ||
    result.localProjectId !== request.localProjectId ||
    result.sessionId !== request.sessionId ||
    result.view !== request.view
  )
    throw new Error('Skills 内容不属于当前请求');
  if (result.view === 'list') {
    const sources = new Map(result.sources.map((source) => [source.id, source]));
    if (
      sources.size !== result.sources.length ||
      new Set(result.skills.map((skill) => skill.id)).size !== result.skills.length ||
      result.skills.some((skill) => sources.get(skill.sourceId)?.status !== 'available') ||
      result.issues.some((issue) => !sources.has(issue.sourceId))
    )
      throw new Error('Skills 目录响应无效');
  } else if (request.view === 'detail') {
    if (
      result.catalogVersion !== request.catalogVersion ||
      result.executionRevision !== request.executionRevision ||
      result.source.id !== request.sourceId ||
      result.source.status !== 'available' ||
      result.skill.sourceId !== request.sourceId ||
      result.skill.id !== request.skillId ||
      result.skill.version !== request.version ||
      new TextEncoder().encode(result.text).length !== result.skill.byteLength
    )
      throw new Error('Skill 版本或来源已改变，请重新读取');
  }
  return result;
}
