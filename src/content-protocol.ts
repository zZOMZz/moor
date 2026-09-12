import { z } from 'zod';
import { id } from './protocol';

// Content envelopes are versioned independently of the session document. Only
// each operation has its own advertised capability; references do not authorize a read.
export const CONTENT_VERSION = 1;
export const FILE_CONTENT_FEATURE = 'file-content-v1';
export const CONTENT_LIMITS = {
  fileBytes: 1024 * 1024,
  attachmentBytes: 8 * 1024 * 1024,
  diffFiles: 500,
  pathLength: 4096,
} as const;
export function isCanonicalBase64(value: string) {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = padding ? value.slice(0, -padding) : value;
  if (/[^A-Za-z0-9+/]/.test(body)) return false;
  const last = body.at(-1) ?? '';
  return (
    !padding ||
    (padding === 2 ? 'AQgw'.includes(last) && !!last : 'AEIMQUYcgkosw048'.includes(last) && !!last)
  );
}
export const contentVersionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const projectFilePathSchema = z
  .string()
  .min(1)
  .max(CONTENT_LIMITS.pathLength)
  .refine(
    (value) =>
      !/[\\\u0000-\u001f\u007f:]/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    '需要规范的项目内相对文件路径',
  );
export const contentScopeSchema = z
  .object({ workspaceId: id, localProjectId: id, sessionId: id })
  .strict();
export const contentDescriptorSchema = z
  .object({
    version: contentVersionSchema,
    byteLength: z.number().int().nonnegative().max(CONTENT_LIMITS.attachmentBytes),
    mediaType: z
      .string()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  })
  .strict();
export const projectFileReadSchema = contentScopeSchema
  .extend({
    contentVersion: z.literal(CONTENT_VERSION),
    path: projectFilePathSchema,
    knownVersion: contentVersionSchema.optional(),
  })
  .strict();
const fileResponseBase = contentScopeSchema.extend({
  contentVersion: z.literal(CONTENT_VERSION),
  path: projectFilePathSchema,
  content: contentDescriptorSchema.extend({
    byteLength: z.number().int().nonnegative().max(CONTENT_LIMITS.fileBytes),
    mediaType: z.enum(['text/plain', 'application/octet-stream']),
  }),
  confirmed: z.literal(true),
});
const base64Schema = z
  .string()
  .max(4 * Math.ceil(CONTENT_LIMITS.fileBytes / 3))
  .refine(isCanonicalBase64);
export const projectFileResultSchema = z
  .discriminatedUnion('status', [
    fileResponseBase
      .extend({ status: z.literal('content'), encoding: z.literal('base64'), data: base64Schema })
      .strict(),
    fileResponseBase.extend({ status: z.literal('not-modified') }).strict(),
  ])
  .refine(
    (result) =>
      result.status !== 'content' ||
      (result.data.length / 4) * 3 -
        (result.data.endsWith('==') ? 2 : result.data.endsWith('=') ? 1 : 0) ===
        result.content.byteLength,
    '内容字节数不匹配',
  );

// References describe immutable content, while the host grants scoped access
// through the separately advertised attachment and saved-diff operations.
export const attachmentReferenceSchema = z
  .object({
    contentVersion: z.literal(CONTENT_VERSION),
    attachmentId: id,
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((name) => !/[\/\\\u0000-\u001f\u007f]/.test(name)),
    content: contentDescriptorSchema,
  })
  .strict();
export const fileChangeSchema = z
  .object({
    path: projectFilePathSchema,
    previousPath: projectFilePathSchema.optional(),
    before: contentDescriptorSchema.nullable(),
    after: contentDescriptorSchema.nullable(),
  })
  .strict()
  .refine((change) => change.before !== null || change.after !== null)
  .refine(
    (change) =>
      !change.previousPath ||
      (change.before !== null && change.after !== null && change.previousPath !== change.path),
  );
export const fileDiffReferenceSchema = z
  .object({
    contentVersion: z.literal(CONTENT_VERSION),
    turnId: id,
    basis: z.literal('project-snapshot'),
    files: z.array(fileChangeSchema).max(CONTENT_LIMITS.diffFiles),
  })
  .strict()
  .refine((diff) => {
    const before = new Set<string>(),
      after = new Set<string>();
    for (const file of diff.files) {
      const source = file.previousPath ?? file.path;
      if ((file.before && before.has(source)) || (file.after && after.has(file.path))) return false;
      if (file.before) before.add(source);
      if (file.after) after.add(file.path);
    }
    return true;
  }, '文件基线来源或目标路径重复');
export type ContentScope = z.infer<typeof contentScopeSchema>;
export type ContentDescriptor = z.infer<typeof contentDescriptorSchema>;
export type ProjectFileRead = z.infer<typeof projectFileReadSchema>;
export type ProjectFileResult = z.infer<typeof projectFileResultSchema>;
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;
export type FileDiffReference = z.infer<typeof fileDiffReferenceSchema>;
