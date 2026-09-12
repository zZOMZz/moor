import { z } from 'zod';
import { id } from '../protocol';
import {
  CONTENT_VERSION,
  CONTENT_LIMITS,
  contentScopeSchema,
  contentVersionSchema,
  projectFilePathSchema,
  type ContentScope,
} from '../content-protocol';
import {
  projectTreeReadSchema,
  projectTreeResultSchema,
  projectTurnDiffReadSchema,
  projectTurnDiffResultSchema,
  projectDiffFileReadSchema,
  projectDiffFileResultSchema,
  type ProjectTreeRead,
  type ProjectTreeResult,
  type ProjectTurnDiffResult,
  type ProjectDiffReference,
  type ProjectDiffChange,
  type ProjectDiffFileResult,
} from '../project-content-protocol';
import { readProjectFile, type FileContentView } from './file-content';

const targetSchema = contentScopeSchema
  .extend({
    owner: z.string().min(1),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
  })
  .strict();
export type ProjectContentTarget = z.infer<typeof targetSchema>;
export type ProjectContentDependencies = {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  request(path: string, body: unknown): Promise<unknown>;
};
export type ProjectContentView<T> = { result: T; source: 'host' | 'cache'; cacheSaved: boolean };
export function projectContentKey(target: ProjectContentTarget, ...parts: (string | number)[]) {
  const value = targetSchema.parse(target);
  return (
    'project-content-v1/' +
    JSON.stringify([
      value.owner,
      value.deviceId,
      value.workspaceId,
      value.localProjectId,
      value.sessionId,
      ...parts,
    ])
  );
}
function scope(target: ProjectContentTarget) {
  const { workspaceId, localProjectId, sessionId } = targetSchema.parse(target);
  return { contentVersion: CONTENT_VERSION as 1, workspaceId, localProjectId, sessionId };
}
function sameScope(target: ContentScope, result: ContentScope) {
  if (
    target.workspaceId !== result.workspaceId ||
    target.localProjectId !== result.localProjectId ||
    target.sessionId !== result.sessionId
  )
    throw new Error('内容响应与当前电脑、项目或会话不匹配。');
}
function endpoint(target: ProjectContentTarget, name: string) {
  return `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/${name}`;
}
async function save(key: string, value: unknown, dependencies: ProjectContentDependencies) {
  try {
    await dependencies.write(key, value);
    return true;
  } catch {
    return false;
  }
}
// Tree and file selectors point to an explicitly labelled last-read cache. The
// bytes and each paginated tree version remain immutable and separately keyed.
export async function readProjectTree(
  target: ProjectContentTarget,
  options: Pick<ProjectTreeRead, 'offset' | 'limit' | 'knownVersion'>,
  online: boolean,
  dependencies: ProjectContentDependencies,
): Promise<ProjectContentView<ProjectTreeResult>> {
  const request = projectTreeReadSchema.parse({ ...scope(target), ...options });
  const index = projectContentKey(target, 'tree-last-read');
  if (!online && !request.knownVersion) {
    const cachedVersion = contentVersionSchema.safeParse(await dependencies.read(index));
    if (cachedVersion.success) request.knownVersion = cachedVersion.data;
  }
  const offset = request.offset ?? 0,
    limit = request.limit ?? 200;
  const key = (version: string) => projectContentKey(target, 'tree', version, offset, limit);
  const raw = online
    ? await dependencies.request(endpoint(target, 'project-tree'), request)
    : request.knownVersion
      ? await dependencies.read(key(request.knownVersion))
      : undefined;
  if (raw === undefined) throw new Error('执行电脑离线，本机没有这个目录版本的缓存。');
  const result = projectTreeResultSchema.parse(raw);
  sameScope(request, result);
  const end = offset + result.entries.length;
  if (
    result.offset !== offset ||
    result.entries.length > limit ||
    end > result.total ||
    (request.knownVersion && result.version !== request.knownVersion) ||
    (result.nextOffset === undefined
      ? end !== result.total
      : result.nextOffset !== end || end >= result.total || end <= offset) ||
    new Set(result.entries.map((entry) => entry.path)).size !== result.entries.length
  )
    throw new Error('文件树页码或内容版本不匹配，请重新读取目录。');
  let cacheSaved = true;
  if (online) {
    cacheSaved = await save(key(result.version), result, dependencies);
    if (cacheSaved && offset === 0) cacheSaved = await save(index, result.version, dependencies);
  }
  return { result, source: online ? 'host' : 'cache', cacheSaved };
}
export async function readCurrentProjectFile(
  target: ProjectContentTarget,
  path: string,
  online: boolean,
  dependencies: ProjectContentDependencies,
): Promise<FileContentView> {
  projectFilePathSchema.parse(path);
  const key = projectContentKey(target, 'file-last-read', path);
  const savedVersion = contentVersionSchema.safeParse(
    await dependencies.read(key).catch(() => undefined),
  );
  const { owner, deviceId, catalogWorkspaceId, replicaId } = targetSchema.parse(target);
  const view = await readProjectFile(
    { owner, deviceId, catalogWorkspaceId, replicaId },
    {
      ...scope(target),
      path,
      ...(savedVersion.success ? { knownVersion: savedVersion.data } : {}),
    },
    online,
    dependencies,
  );
  if (online && view.cacheSaved)
    view.cacheSaved = await save(key, view.result.content.version, dependencies);
  return view;
}
export async function readProjectTurnDiff(
  target: ProjectContentTarget,
  turnId: string,
  online: boolean,
  dependencies: ProjectContentDependencies,
  expected?: ProjectDiffReference,
): Promise<ProjectContentView<ProjectTurnDiffResult>> {
  const request = projectTurnDiffReadSchema.parse({ ...scope(target), turnId });
  const key = projectContentKey(target, 'turn-diff', turnId, expected?.version ?? 'last-read');
  const raw = online
    ? await dependencies.request(endpoint(target, 'turn-diff'), request)
    : await dependencies.read(key);
  if (raw === undefined) throw new Error('执行电脑离线，本机没有这个回合变更的缓存。');
  const result = projectTurnDiffResultSchema.parse(raw);
  sameScope(request, result);
  if (
    result.turnId !== turnId ||
    (result.reference && result.reference.turnId !== turnId) ||
    (expected && result.reference?.diffId !== expected.diffId) ||
    (expected?.version && result.reference?.version !== expected.version) ||
    (result.reference && result.reference.state !== result.state) ||
    (result.reference && result.reference.changeCount !== result.changes.length) ||
    (result.state === 'ready' && result.partial) ||
    new Set(result.changes.map((entry) => entry.path)).size !== result.changes.length
  )
    throw new Error('回合变更与当前记录或内容版本不匹配。');
  for (const change of result.changes) validateChange(change);
  let cacheSaved = true;
  if (online) {
    cacheSaved = await save(key, result, dependencies);
    if (result.reference?.version)
      cacheSaved =
        (await save(
          projectContentKey(target, 'turn-diff', turnId, result.reference.version),
          result,
          dependencies,
        )) && cacheSaved;
  }
  return { result, source: online ? 'host' : 'cache', cacheSaved };
}
function validateChange(change: ProjectDiffChange) {
  if (
    (!change.before && !change.after) ||
    (change.after && change.after.path !== change.path) ||
    (change.before && change.before.path !== (change.previousPath ?? change.path)) ||
    (change.kind === 'added' && (change.before !== null || change.after === null)) ||
    (change.kind === 'deleted' && (change.before === null || change.after !== null)) ||
    (['modified', 'renamed'].includes(change.kind) && (!change.before || !change.after)) ||
    (change.kind === 'renamed' && (!change.previousPath || change.previousPath === change.path))
  )
    throw new Error('文件变更的前后路径或类型不匹配。');
}
export async function readProjectDiffFile(
  target: ProjectContentTarget,
  reference: ProjectDiffReference,
  change: ProjectDiffChange,
  online: boolean,
  dependencies: ProjectContentDependencies,
): Promise<ProjectContentView<ProjectDiffFileResult>> {
  if (!reference.version) throw new Error('这个回合尚未保存可读取的文件基线。');
  validateChange(change);
  const request = projectDiffFileReadSchema.parse({
    ...scope(target),
    turnId: reference.turnId,
    path: change.path,
    knownVersion: reference.version,
  });
  const key = projectContentKey(
    target,
    'diff-file',
    reference.turnId,
    reference.version,
    change.path,
  );
  const raw = online
    ? await dependencies.request(endpoint(target, 'diff-file'), request)
    : await dependencies.read(key);
  if (raw === undefined) throw new Error('执行电脑离线，本机没有这个历史文件版本的缓存。');
  const result = projectDiffFileResultSchema.parse(raw);
  sameScope(request, result);
  if (
    result.turnId !== request.turnId ||
    result.path !== change.path ||
    result.reference.turnId !== request.turnId ||
    result.reference.diffId !== reference.diffId ||
    result.reference.version !== reference.version ||
    result.reference.state !== reference.state ||
    result.reference.changeCount !== reference.changeCount
  )
    throw new Error('历史文件响应与当前回合或基线版本不匹配。');
  for (const side of ['before', 'after'] as const) {
    const file = result[side],
      summary = change[side];
    if (!file && !summary) continue;
    if (
      !file ||
      !summary ||
      file.path !== summary.path ||
      file.state !== summary.state ||
      file.size !== summary.size ||
      file.version !== summary.version ||
      file.mediaType !== summary.mediaType
    )
      throw new Error('历史文件与所选变更不匹配。');
    if (file.state === 'text') {
      if (typeof file.text !== 'string' || file.mediaType !== 'text/plain' || !file.version)
        throw new Error('历史文本没有完整的基线内容。');
      const bytes = new TextEncoder().encode(file.text);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const version =
        'sha256:' + [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
      if (
        bytes.length !== file.size ||
        bytes.length > CONTENT_LIMITS.fileBytes ||
        version !== file.version ||
        file.text.includes('\0')
      )
        throw new Error('历史文件内容校验失败。');
    } else if (file.text !== undefined) throw new Error('不可预览的文件不能携带文本内容。');
  }
  const cacheSaved = online ? await save(key, result, dependencies) : true;
  return { result, source: online ? 'host' : 'cache', cacheSaved };
}

export type DiffLine = {
  kind: 'same' | 'added' | 'removed';
  text: string;
  before?: number;
  after?: number;
};
// A bounded LCS gives useful line highlights for small files. Larger comparisons
// deliberately fall back to exact before/after text without guessed changes.
export function compareTextLines(before: string, after: string): DiffLine[] | undefined {
  const a = before ? before.split('\n') : [],
    b = after ? after.split('\n') : [];
  if (a.length * b.length > 1_000_000 || a.length + b.length > 4000) return undefined;
  const width = b.length + 1,
    scores = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      scores[i * width + j] =
        a[i] === b[j]
          ? scores[(i + 1) * width + j + 1] + 1
          : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i], before: ++i, after: ++j });
    } else if (
      i < a.length &&
      (j === b.length || scores[(i + 1) * width + j] >= scores[i * width + j + 1])
    )
      lines.push({ kind: 'removed', text: a[i], before: ++i });
    else lines.push({ kind: 'added', text: b[j], after: ++j });
  }
  return lines;
}
