import type { FeatureContext } from './feature-context';
import {
  attachmentActionSchema,
  attachmentContentSchema,
  ATTACHMENTS_FEATURE,
  MAX_TURN_ATTACHMENTS,
} from '@moor/protocol/attachment-protocol';
import {
  attachmentReferenceSchema,
  type AttachmentReference,
} from '@moor/protocol/content-protocol';
import { z } from 'zod';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import {
  createAttachmentDraftItem,
  verifyAttachmentBytes,
  type AttachmentSource,
} from '../attachments/attachments';
import { emptyWorkspaceAttachments } from '../attachments/workspace-attachments';
import type { WorkspaceCommandsService } from './commands';
import type { WorkspaceDraftsService } from './drafts';
import { Context, same } from './model';
/** Capabilities consumed by attachments use cases; supplied only by the workspace composition root. */
export interface WorkspaceAttachmentsPorts {
  drafts: Pick<WorkspaceDraftsService, 'flushDraft' | 'reloadLedger'>;
  context: FeatureContext<
    'context' | 'value' | 'uuid' | 'execute' | 'command',
    'ledger' | 'offline',
    'read-attachment',
    never
  >;
  store: Pick<WorkspacePersistence, 'saveAttachments' | 'attachmentContent' | 'stage'>;
  commands: Pick<WorkspaceCommandsService, 'deliverOperation'>;
}
export class WorkspaceAttachmentsService {
  constructor(readonly ports: WorkspaceAttachmentsPorts) {}
  async addAttachments(files: readonly AttachmentSource[], expectedCurrent: () => void = () => {}) {
    await this.ports.drafts.flushDraft();
    expectedCurrent();
    const context = this.ports.context.context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const before = structuredClone(
      this.ports.context.value.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    if (files.length + before.items.length > MAX_TURN_ATTACHMENTS)
      throw Error(`每条指令最多添加 ${MAX_TURN_ATTACHMENTS} 个附件。`);
    const additions = [];
    for (const file of [...files]) {
      additions.push(await createAttachmentDraftItem(file, this.ports.context.uuid()));
      context.current();
    }
    await this.ports.store.saveAttachments(
      context.scope,
      sessionId,
      before.revision,
      [...before.items, ...additions],
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
  }
  async readAttachment(input: AttachmentReference) {
    const reference = attachmentReferenceSchema.parse(input),
      context = this.ports.context.context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    if (this.ports.context.value.offline) {
      const cached = await this.ports.store.attachmentContent(
        context.scope,
        sessionId,
        reference,
        context.current,
      );
      if (!cached) throw Error('本机尚无此附件缓存，请恢复原电脑连接后读取。');
      return { reference, data: cached.data, source: 'cache' as const, cacheSaved: true };
    }
    const target = context.scope.target;
    const value = attachmentContentSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'read-attachment', {
          contentVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId,
          attachmentId: reference.attachmentId,
        }),
      ),
    );
    if (!same(reference, value.attachment)) throw Error('附件内容与所选引用不匹配。');
    await verifyAttachmentBytes(reference, value.data);
    context.current();
    let cacheSaved = false;
    try {
      await this.ports.store.attachmentContent(
        context.scope,
        sessionId,
        reference,
        context.current,
        value,
      );
      cacheSaved = true;
    } catch {
      context.current();
    }
    return { reference, data: value.data, source: 'host' as const, cacheSaved };
  }
  async uploadAttachment(attachmentId: string) {
    return this.attachmentAction(attachmentId, 'upload');
  }
  async removeAttachment(attachmentId: string) {
    return this.attachmentAction(attachmentId, 'remove');
  }
  async attachmentAction(attachmentId: string, action: 'upload' | 'remove') {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const attachments = structuredClone(
      this.ports.context.value.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    const item = attachments.items.find((item) => item.reference.attachmentId === attachmentId);
    if (!item) throw Error('附件不存在，请重新读取。');
    if (item.pending) throw Error('附件尚未确认，请先核查或手动重试原操作。');
    if (action === 'remove' && !item.uploaded) {
      await this.ports.store.saveAttachments(
        context.scope,
        sessionId,
        attachments.revision,
        attachments.items.filter((entry) => entry.reference.attachmentId !== attachmentId),
        context.current,
      );
      await this.ports.drafts.reloadLedger(context);
      return;
    }
    if (action === 'upload' && item.uploaded) return;
    if (!context.project.runtime.features?.includes(ATTACHMENTS_FEATURE))
      throw Error('执行电脑暂不支持附件，请更新主机。');
    const target = context.scope.target;
    const value = attachmentActionSchema.parse({
      contentVersion: 1,
      operationId: this.ports.context.uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId,
      action,
      ...(action === 'upload' ? { attachment: item.reference, data: item.data } : { attachmentId }),
    });
    return this.performAttachmentAction(context, value);
  }
  async performAttachmentAction(context: Context, value: z.infer<typeof attachmentActionSchema>) {
    await this.ports.store.stage(
      context.scope,
      { kind: 'attachment', value },
      undefined,
      context.current,
    );
    await this.ports.drafts.reloadLedger(context);
    await this.ports.commands.deliverOperation(context, value.operationId);
    await this.ports.drafts.reloadLedger(context);
  }
}
