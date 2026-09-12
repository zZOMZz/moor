import { z } from 'zod';
import { id } from '../protocol';
import {
  CONTENT_VERSION,
  contentVersionSchema,
  projectFileReadSchema,
  projectFileResultSchema,
  type ProjectFileRead,
  type ProjectFileResult,
} from '../content-protocol';

const targetSchema = z
  .object({
    owner: z.string().min(1).max(200),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
  })
  .strict();
export type FileContentTarget = z.infer<typeof targetSchema>;
type FileContent = Extract<ProjectFileResult, { status: 'content' }>;
const cacheSchema = z
  .object({
    cacheVersion: z.literal(CONTENT_VERSION),
    owner: z.string(),
    deviceId: id,
    result: projectFileResultSchema,
  })
  .strict();
export type FileContentView = {
  source: 'host' | 'cache';
  // Cache bytes are immutable, but the current project file may have changed.
  stale: boolean;
  result: FileContent;
  bytes: Uint8Array;
  text?: string;
  cacheSaved: boolean;
};
type Dependencies = {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  request(path: string, input: ProjectFileRead): Promise<unknown>;
};

export function fileContentCacheKey(
  target: FileContentTarget,
  input: ProjectFileRead,
  version: string,
) {
  const route = targetSchema.parse(target),
    request = projectFileReadSchema.parse(input);
  return (
    'file-content-v1/' +
    JSON.stringify([
      route.owner,
      route.deviceId,
      request.workspaceId,
      request.localProjectId,
      request.sessionId,
      request.path,
      contentVersionSchema.parse(version),
    ])
  );
}
function sameFile(request: ProjectFileRead, result: ProjectFileResult) {
  return (
    request.contentVersion === result.contentVersion &&
    request.workspaceId === result.workspaceId &&
    request.localProjectId === result.localProjectId &&
    request.sessionId === result.sessionId &&
    request.path === result.path
  );
}
async function verifiedContent(result: FileContent) {
  const binary = atob(result.data),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const version =
    'sha256:' + [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (version !== result.content.version) throw new Error('文件内容校验失败，请重新读取。');
  let text: string | undefined;
  if (result.content.mediaType === 'text/plain') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('binary');
    } catch {
      throw new Error('主机返回的文本编码无效，请重新读取。');
    }
  }
  return { bytes, text };
}

// This read-only client is separate from prompt delivery and attachment drafts.
// Each invocation is explicit. There is no reconnect listener or mutable "latest"
// cache pointer: callers retain the exact version they have displayed.
export async function readProjectFile(
  target: FileContentTarget,
  input: ProjectFileRead,
  online: boolean,
  dependencies: Dependencies,
): Promise<FileContentView> {
  const route = targetSchema.parse(target),
    request = projectFileReadSchema.parse(input);
  let cached: { result: FileContent; bytes: Uint8Array; text?: string } | undefined;
  if (request.knownVersion) {
    const key = fileContentCacheKey(route, request, request.knownVersion);
    try {
      const entry = cacheSchema.safeParse(await dependencies.read(key));
      if (
        entry.success &&
        entry.data.owner === route.owner &&
        entry.data.deviceId === route.deviceId &&
        entry.data.result.status === 'content' &&
        sameFile(request, entry.data.result) &&
        entry.data.result.content.version === request.knownVersion
      ) {
        cached = { result: entry.data.result, ...(await verifiedContent(entry.data.result)) };
      }
    } catch {
      // Unreadable or invalid cache entries cannot authorize a conditional read.
    }
  }
  if (!online) {
    if (!cached) throw new Error('执行电脑离线，本机没有这个版本的文件缓存。');
    return { ...cached, source: 'cache', stale: true, cacheSaved: true };
  }
  const { knownVersion: _knownVersion, ...fullRequest } = request;
  const sent = cached ? request : fullRequest;
  const parsed = projectFileResultSchema.safeParse(
    await dependencies.request(
      `/api/workspaces/${route.catalogWorkspaceId}/replicas/${route.replicaId}/file-content`,
      sent,
    ),
  );
  if (!parsed.success || !sameFile(request, parsed.data))
    throw new Error('文件响应与当前会话或协议不匹配。');
  const result = parsed.data;
  if (result.status === 'not-modified') {
    if (
      !cached ||
      result.content.version !== request.knownVersion ||
      result.content.byteLength !== cached.result.content.byteLength ||
      result.content.mediaType !== cached.result.content.mediaType
    )
      throw new Error('主机确认的文件版本没有对应缓存，请重新读取。');
    return { ...cached, source: 'host', stale: false, cacheSaved: true };
  }
  const content = await verifiedContent(result);
  let cacheSaved = true;
  try {
    await dependencies.write(fileContentCacheKey(route, request, result.content.version), {
      cacheVersion: CONTENT_VERSION,
      owner: route.owner,
      deviceId: route.deviceId,
      result,
    });
  } catch {
    // The host read succeeded even when local storage is full or unavailable.
    cacheSaved = false;
  }
  return { result, ...content, source: 'host', stale: false, cacheSaved };
}
