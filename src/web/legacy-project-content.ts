import { z } from 'zod';
import { id } from '../protocol';
import {
  contentVersionSchema,
  projectFilePathSchema,
  projectFileResultSchema,
} from '../content-protocol';
import {
  projectTreeResultSchema,
  projectTurnDiffResultSchema,
  projectDiffFileResultSchema,
  type ProjectDiffChange,
} from '../project-content-protocol';
import {
  readProjectTree,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
} from './project-content';
import { readProjectFile } from './file-content';

export const legacyContentEntriesSchema = z
  .array(z.object({ key: z.string().max(4096), value: z.unknown() }).strict())
  .max(10000)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.key)).size === entries.length,
    '旧文件缓存有重复键。',
  );
export type LegacyContentEntries = z.infer<typeof legacyContentEntriesSchema>;
const fileCacheSchema = z
  .object({
    cacheVersion: z.literal(1),
    owner: z.string(),
    deviceId: id,
    result: projectFileResultSchema,
  })
  .strict();
const tuple = z
  .tuple([z.string(), z.string(), z.string(), z.string(), z.string()])
  .rest(z.union([z.string(), z.number()]));
export function legacyContentPrefix(
  target: ProjectContentTarget,
  namespace: 'project-content-v1' | 'file-content-v1',
) {
  return (
    namespace +
    '/' +
    JSON.stringify([
      target.owner,
      target.deviceId,
      target.workspaceId,
      target.localProjectId,
      target.sessionId,
    ]).slice(0, -1) +
    ','
  );
}
/** Shape and identity checks are synchronous for the native cache normalizer. */
export function parseLegacyContentEntry(
  entry: LegacyContentEntries[number],
  target: ProjectContentTarget,
) {
  const namespace = entry.key.split('/')[0];
  if (namespace !== 'project-content-v1' && namespace !== 'file-content-v1')
    throw Error('未知文件缓存格式。');
  const parts = tuple.parse(JSON.parse(entry.key.slice(namespace.length + 1)));
  if (
    entry.key !== namespace + '/' + JSON.stringify(parts) ||
    !entry.key.startsWith(legacyContentPrefix(target, namespace))
  )
    throw Error('旧文件缓存不属于原会话。');
  const tail = parts.slice(5);
  const version = (value: unknown) => contentVersionSchema.parse(value);
  const scope = (value: { workspaceId: string; localProjectId: string; sessionId: string }) => {
    if (
      value.workspaceId !== target.workspaceId ||
      value.localProjectId !== target.localProjectId ||
      value.sessionId !== target.sessionId
    )
      throw Error('旧文件缓存响应范围不匹配。');
  };
  if (namespace === 'file-content-v1') {
    const [path, digest] = z.tuple([projectFilePathSchema, contentVersionSchema]).parse(tail);
    const value = fileCacheSchema.parse(entry.value);
    scope(value.result);
    if (
      value.owner !== target.owner ||
      value.deviceId !== target.deviceId ||
      value.result.status !== 'content' ||
      value.result.path !== path ||
      value.result.content.version !== digest
    )
      throw Error('旧文件缓存内容与键不匹配。');
    return { kind: 'file' as const, path, digest };
  }
  switch (tail[0]) {
    case 'tree-last-read':
      z.tuple([z.literal('tree-last-read')]).parse(tail);
      version(entry.value);
      return { kind: 'selector' as const };
    case 'file-last-read':
      z.tuple([z.literal('file-last-read'), projectFilePathSchema]).parse(tail);
      version(entry.value);
      return { kind: 'selector' as const };
    case 'tree': {
      const [, digest, offset, limit] = z
        .tuple([
          z.literal('tree'),
          contentVersionSchema,
          z.number().int().nonnegative(),
          z.number().int().positive(),
        ])
        .parse(tail);
      const value = projectTreeResultSchema.parse(entry.value);
      scope(value);
      if (value.version !== digest || value.offset !== offset)
        throw Error('旧目录版本或页码不匹配。');
      return { kind: 'tree' as const, digest, offset, limit };
    }
    case 'turn-diff': {
      const [, turnId, digest] = z
        .tuple([
          z.literal('turn-diff'),
          id,
          z.union([contentVersionSchema, z.literal('last-read')]),
        ])
        .parse(tail);
      const value = projectTurnDiffResultSchema.parse(entry.value);
      scope(value);
      if (
        value.turnId !== turnId ||
        (digest !== 'last-read' && value.reference?.version !== digest)
      )
        throw Error('旧回合变更版本不匹配。');
      return { kind: 'turn' as const, turnId, digest, value };
    }
    case 'diff-file': {
      const [, turnId, digest, path] = z
        .tuple([z.literal('diff-file'), id, contentVersionSchema, projectFilePathSchema])
        .parse(tail);
      const value = projectDiffFileResultSchema.parse(entry.value);
      scope(value);
      if (value.turnId !== turnId || value.reference.version !== digest || value.path !== path)
        throw Error('旧历史文件版本不匹配。');
      return { kind: 'diff' as const, value };
    }
    default:
      throw Error('未知文件缓存键。');
  }
}
/** Reuse the same offline validators as normal reading, including byte digests. */
export async function validateLegacyContent(
  entries: LegacyContentEntries,
  input: ProjectContentTarget,
  current: () => void,
) {
  const { owner, deviceId, catalogWorkspaceId, replicaId, workspaceId, localProjectId, sessionId } =
    input;
  const target = {
    owner,
    deviceId,
    catalogWorkspaceId,
    replicaId,
    workspaceId,
    localProjectId,
    sessionId,
  };
  const records = legacyContentEntriesSchema.parse(entries);
  const values = new Map(records.map((entry) => [entry.key, entry.value]));
  if (values.size !== records.length) throw Error('旧文件缓存有重复键。');
  const dependencies = {
    read: async (key: string) => {
      current();
      return values.get(key);
    },
    write: async () => {
      throw Error('恢复检查不写缓存。');
    },
    request: async () => {
      throw Error('恢复检查不请求主机。');
    },
  };
  for (const entry of records) {
    current();
    const parsed = parseLegacyContentEntry(entry, target);
    if (parsed.kind === 'tree')
      await readProjectTree(
        target,
        { knownVersion: parsed.digest, offset: parsed.offset, limit: parsed.limit },
        false,
        dependencies,
      );
    else if (parsed.kind === 'file')
      await readProjectFile(
        {
          owner: target.owner,
          deviceId: target.deviceId,
          catalogWorkspaceId: target.catalogWorkspaceId,
          replicaId: target.replicaId,
        },
        {
          contentVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
          path: parsed.path,
          knownVersion: parsed.digest,
        },
        false,
        dependencies,
      );
    else if (parsed.kind === 'turn')
      await readProjectTurnDiff(
        target,
        parsed.turnId,
        false,
        dependencies,
        parsed.digest === 'last-read' ? undefined : parsed.value.reference,
      );
    else if (parsed.kind === 'diff') {
      const { before, after, path, reference } = parsed.value;
      const renamed = before && after && before.path !== after.path;
      const change: ProjectDiffChange = {
        path,
        kind: !before ? 'added' : !after ? 'deleted' : renamed ? 'renamed' : 'modified',
        before,
        after,
        ...(renamed ? { previousPath: before.path } : {}),
      };
      await readProjectDiffFile(target, reference, change, false, dependencies);
    }
    current();
  }
}
