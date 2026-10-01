import { decodeBase64, utf8 } from '@moor/protocol/binary';
import {
  CONTENT_LIMITS,
  attachmentReferenceSchema,
  isCanonicalBase64,
  type AttachmentReference,
} from '@moor/protocol/content-protocol';
import {
  isPrivateEndpointEnvelope,
  isPrivateEndpointEnvelopeValue,
} from '@moor/protocol/private-content';
import type { HostEnvironment } from '../runtime/environment';

type AttachedContent = { type: 'attachment'; attachment: AttachmentReference };
type TextContent = { type: 'text'; text: string };
type SaveAttachment = (reference: AttachmentReference, bytes: Uint8Array) => AttachmentReference;
const omitted = (reason: string): TextContent => ({ type: 'text', text: `[${reason}]` });
const privateText = (value: string) => isPrivateEndpointEnvelope(utf8(value));
export const normalizeAgentText = (text: string): TextContent =>
  privateText(text)
    ? omitted('Agent 返回的内容属于 Moor 主机私有配置，未保存')
    : { type: 'text', text };
const filename = (resource: any, mediaType: string) => {
  let candidate: string | undefined;
  if (typeof resource?.uri === 'string') {
    try {
      const url = new URL(resource.uri);
      candidate = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    } catch {}
  }
  return (
    candidate?.replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200) ||
    `agent-output.${mediaType === 'text/plain' ? 'txt' : mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'audio/wav' ? 'wav' : 'bin'}`
  );
};

// Only embedded bytes supplied by the ACP Agent become downloadable artifacts.
// Resource URLs never grant permission to fetch a URL or read a host path.
export function normalizeAgentContent(
  value: any,
  save: SaveAttachment,
  identity: Pick<HostEnvironment, 'uuid' | 'hash'>,
): AttachedContent | TextContent {
  if (value?.type === 'text' && typeof value.text === 'string')
    return normalizeAgentText(value.text);
  if (value?.type === 'resource_link') return omitted('Agent 返回的资源链接暂不可读取');
  if (!['image', 'audio', 'resource'].includes(value?.type))
    return omitted('Agent 返回了暂不支持的内容');
  try {
    const resource = value.type === 'resource' ? value.resource : undefined;
    const text = resource?.text;
    const encoded = resource ? resource.blob : value.data;
    const mediaType = resource
      ? (resource.mimeType ??
        (typeof text === 'string' ? 'text/plain' : 'application/octet-stream'))
      : value.mimeType;
    let bytes: Uint8Array;
    if (typeof text === 'string') {
      if (utf8(text).byteLength > CONTENT_LIMITS.attachmentBytes)
        return omitted('Agent 返回的附件超过 8 MiB，未保存');
      bytes = utf8(text);
    } else {
      if (
        typeof encoded !== 'string' ||
        encoded.length > 4 * Math.ceil(CONTENT_LIMITS.attachmentBytes / 3) ||
        !isCanonicalBase64(encoded)
      )
        return omitted('Agent 返回的附件格式无效或超过 8 MiB，未保存');
      bytes = decodeBase64(encoded);
    }
    if (isPrivateEndpointEnvelope(bytes))
      return omitted('Agent 返回的附件属于 Moor 主机私有配置，未保存');
    const reference = attachmentReferenceSchema.parse({
      contentVersion: 1,
      attachmentId: 'attachment_' + identity.uuid(),
      name: filename(resource, mediaType),
      content: {
        version: 'sha256:' + identity.hash(bytes),
        byteLength: bytes.length,
        mediaType,
      },
    });
    try {
      return { type: 'attachment', attachment: save(reference, bytes) };
    } catch (error) {
      if ((error as { status?: number }).status === 413)
        return omitted('Agent 返回的附件超出会话容量，未保存');
      throw error;
    }
  } catch (error) {
    // Database errors must roll back the entire output update, not leave an orphan blob.
    if (error instanceof Error && !['ZodError', 'TypeError', 'RangeError'].includes(error.name))
      throw error;
    return omitted('Agent 返回的附件无效或超出会话容量，未保存');
  }
}

export function normalizeAgentToolContent(
  value: any,
  save: SaveAttachment,
  identity: Pick<HostEnvironment, 'uuid' | 'hash'>,
): any[] {
  if (!Array.isArray(value))
    return [{ type: 'content', content: omitted('Agent 工具内容格式无效') }];
  return value.map((item) => {
    if (item?.type === 'content')
      return { type: 'content', content: normalizeAgentContent(item.content, save, identity) };
    if (
      item?.type === 'diff' &&
      typeof item.path === 'string' &&
      (typeof item.oldText === 'string' || item.oldText === null) &&
      typeof item.newText === 'string'
    ) {
      if (
        (typeof item.oldText === 'string' && privateText(item.oldText)) ||
        privateText(item.newText)
      )
        return {
          type: 'content',
          content: omitted('Agent 返回的差异属于 Moor 主机私有配置，未保存'),
        };
      return { type: 'diff', path: item.path, oldText: item.oldText, newText: item.newText };
    }
    if (item?.type === 'terminal' && typeof item.terminalId === 'string')
      return { type: 'terminal', terminalId: item.terminalId };
    return { type: 'content', content: omitted('Agent 返回了暂不支持的工具内容') };
  });
}

// Raw tool metadata is useful for inspection, but never serves as a second copy
// of embedded binary data. The normalized content above owns those references.
export function safeAgentMetadata(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[metadata omitted]';
  if (isPrivateEndpointEnvelopeValue(value) || (typeof value === 'string' && privateText(value)))
    return '[Moor 主机私有配置已省略]';
  if (typeof value === 'string' && value.length > 120000 && isCanonicalBase64(value))
    return '[large embedded data omitted]';
  if (Array.isArray(value)) return value.map((item) => safeAgentMetadata(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        key === 'attachmentData' ||
        (key === 'data' && ['image', 'audio'].includes(String(record.type))) ||
        (key === 'resource' && record.type === 'resource')
          ? '[embedded data omitted]'
          : safeAgentMetadata(item, depth + 1),
      ]),
    );
  }
  return value;
}
