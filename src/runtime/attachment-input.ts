import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  attachmentBase64Schema,
  promptAttachmentsSchema,
  type AgentAttachment,
  type PromptInputCapabilities,
} from '../attachment-protocol';
import { assert } from '../protocol';

// Called on host-owned bytes after opening the Agent, so capability changes
// between discovery and launch cannot silently drop a user's attachments.
export function promptContent(
  input: { prompt: string; attachments?: unknown; attachmentData?: AgentAttachment[] },
  capabilities: PromptInputCapabilities,
): ContentBlock[] {
  const references = promptAttachmentsSchema.parse(input.attachments ?? []),
    content: ContentBlock[] = [];
  assert(typeof input.prompt === 'string', 400, '指令格式无效');
  if (input.prompt) content.push({ type: 'text', text: input.prompt });
  assert((input.attachmentData?.length ?? 0) === references.length, 400, '附件内容尚未由主机确认');
  for (let i = 0; i < references.length; i++) {
    const reference = references[i],
      value = input.attachmentData![i];
    assert(isDeepStrictEqual(reference, value.reference), 400, '附件内容与指令不匹配');
    attachmentBase64Schema.parse(value.data);
    const bytes = Buffer.from(value.data, 'base64'),
      mimeType = reference.content.mediaType;
    assert(
      bytes.length === reference.content.byteLength &&
        'sha256:' + createHash('sha256').update(bytes).digest('hex') === reference.content.version,
      400,
      '附件内容校验失败',
    );
    if (mimeType.startsWith('image/')) {
      assert(capabilities.image, 400, '该 Agent 未报告图片输入能力');
      content.push({ type: 'image', mimeType, data: value.data });
    } else if (mimeType.startsWith('audio/')) {
      assert(capabilities.audio, 400, '该 Agent 未报告音频输入能力');
      content.push({ type: 'audio', mimeType, data: value.data });
    } else {
      assert(capabilities.embeddedContext, 400, '该 Agent 未报告文件附件输入能力');
      const uri =
        'moor-attachment://' + reference.attachmentId + '/' + encodeURIComponent(reference.name);
      let text: string | undefined;
      if (
        mimeType.startsWith('text/') ||
        ['application/json', 'application/xml'].includes(mimeType)
      ) {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {}
      }
      content.push({
        type: 'resource',
        resource:
          text !== undefined ? { uri, mimeType, text } : { uri, mimeType, blob: value.data },
      });
    }
  }
  assert(content.length > 0, 400, '请填写指令或添加附件');
  return content;
}
