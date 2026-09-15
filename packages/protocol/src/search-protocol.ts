import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema, projectFilePathSchema } from './content-protocol';

export const SESSION_SEARCH_FEATURE = 'session-search-v1';
export const SEARCH_LIMITS = {
  query: 500,
  results: 100,
  entries: 2000,
  text: 120000,
  documentBytes: 16 * 1024 * 1024,
  candidates: 5000,
  scanBytes: 16 * 1024 * 1024,
} as const;
export const searchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(SEARCH_LIMITS.query)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    '搜索不能包含控制字符',
  );
export const sessionSearchRequestSchema = contentScopeSchema
  .extend({
    searchVersion: z.literal(1),
    // sessionId always identifies the authorized context even for a project search.
    scope: z.enum(['session', 'project']),
    query: searchQuerySchema,
    limit: z.number().int().min(1).max(SEARCH_LIMITS.results).default(30),
  })
  .strict();
export const searchEntrySchema = z
  .object({
    turnId: id,
    itemIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['message', 'tool', 'diff']),
    path: projectFilePathSchema.optional(),
    text: z.string().min(1).max(SEARCH_LIMITS.text),
  })
  .strict();
export const searchHitSchema = searchEntrySchema
  .omit({ text: true })
  .extend({ sessionId: id, excerpt: z.string().max(1000) })
  .strict();
export const sessionSearchResultSchema = contentScopeSchema
  .extend({
    searchVersion: z.literal(1),
    scope: z.enum(['session', 'project']),
    query: z.string().min(1).max(SEARCH_LIMITS.query),
    confirmed: z.literal(true),
    source: z.literal('host-index'),
    hits: z.array(searchHitSchema).max(SEARCH_LIMITS.results),
    more: z.boolean(),
    partial: z.boolean(),
  })
  .strict();
export type SearchEntry = z.infer<typeof searchEntrySchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export type SessionSearchRequest = z.infer<typeof sessionSearchRequestSchema>;
export type SessionSearchResult = z.infer<typeof sessionSearchResultSchema>;
