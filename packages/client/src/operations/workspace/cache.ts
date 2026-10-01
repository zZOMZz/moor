import type { StorageBackend } from '@moor/client/operations/storage';
import { ClientSessionReplica } from '@moor/session/client-session-replica';
import { attachmentContentSchema } from '@moor/protocol/attachment-protocol';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { type AttachmentReference } from '@moor/protocol/content-protocol';
import type { SessionPageRequest } from '@moor/protocol/session-page';
import { sessionListSchema, sessionReadResponseSchema } from '@moor/protocol/session-responses';
import { workspaceProjectTargetSchema } from '@moor/protocol/workspace-client-protocol';
import { z } from 'zod';
import { verifyAttachmentBytes } from '../../features/attachments/attachments';
import {
  cacheWorkspaceSessionDelta,
  loadWorkspaceSessionCache,
} from '../../features/workspace/workspace-session-cache';
import { workspaceSessionPage } from '../../features/workspace/workspace-session-pages';
import { same, scopeSchema, WorkspaceScope } from './model';

/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceCachePersistencePorts {}
export class WorkspaceCachePersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceCachePersistencePorts,
  ) {}
  async cacheSession(scope: WorkspaceScope, sessionId: string, raw: unknown, current: () => void) {
    const replica = new ClientSessionReplica({ ...scopeSchema.parse(scope).target, sessionId });
    try {
      replica.read(raw);
      await this.cacheSessionDelta(scope, sessionId, replica.lastRead, current, () =>
        replica.exportSnapshot(),
      );
    } finally {
      replica.dispose();
    }
  }
  loadSessionCache(scope: WorkspaceScope, sessionId: string, current: () => void) {
    return loadWorkspaceSessionCache(this.backend, scopeSchema.parse(scope), sessionId, current);
  }
  cacheSessionDelta(
    scope: WorkspaceScope,
    sessionId: string,
    verifiedDelta: unknown,
    current: () => void,
    checkpoint: () => z.infer<typeof sessionReadResponseSchema>,
  ) {
    return cacheWorkspaceSessionDelta(
      this.backend,
      scopeSchema.parse(scope),
      sessionId,
      verifiedDelta,
      current,
      checkpoint,
    );
  }
  async sessionList(scope: WorkspaceScope, current: () => void, input?: unknown) {
    const normalized = scopeSchema.parse(scope);
    const key = canonical(['moor-workspace-session-list-v1', normalized]);
    const raw = input === undefined ? await this.backend.read(key) : input;
    current();
    if (raw === null) return undefined;
    const list = sessionListSchema.parse(raw);
    if (
      list.some(
        (item) =>
          item.userId !== normalized.target.userId ||
          item.machineId !== normalized.target.machineId ||
          item.project.localProjectId !== normalized.target.localProjectId,
      )
    )
      throw Error('缓存会话列表不属于原电脑和项目。');
    if (input !== undefined)
      await this.backend.exclusive(key, current, async () => {
        const before = await this.backend.read(key);
        current();
        await this.backend.compareAndSet(key, before, list, current);
      });
    return list;
  }
  async sessionPage(
    scope: WorkspaceScope,
    current: () => void,
    rawRequest: SessionPageRequest,
    input?: unknown,
  ) {
    return workspaceSessionPage(this.backend, scopeSchema.parse(scope), current, rawRequest, input);
  }
  async attachmentContent(
    scope: WorkspaceScope,
    sessionId: string,
    reference: AttachmentReference,
    current: () => void,
    input?: unknown,
  ) {
    const target = scopeSchema.parse(scope).target;
    workspaceProjectTargetSchema.parse({ ...target, sessionId });
    const key = canonical(['moor-desktop-attachment-cache-v1', scope, sessionId, reference]);
    current();
    const raw = input === undefined ? await this.backend.read(key) : input;
    current();
    if (raw == null) return null;
    const value = attachmentContentSchema.parse(raw);
    if (
      value.workspaceId !== target.workspaceId ||
      value.localProjectId !== target.localProjectId ||
      value.sessionId !== sessionId ||
      !same(value.attachment, reference)
    )
      throw Error('附件缓存与原引用不匹配。');
    await verifyAttachmentBytes(reference, value.data);
    current();
    if (input !== undefined)
      await this.backend.exclusive(key, current, async () => {
        const before = await this.backend.read(key);
        current();
        await this.backend.compareAndSet(key, before, value, current);
      });
    current();
    return value;
  }
  async cachedSession(scope: WorkspaceScope, sessionId: string, current: () => void) {
    const chain = await this.loadSessionCache(scope, sessionId, current);
    if (!chain) return null;
    const replica = new ClientSessionReplica({ ...scope.target, sessionId });
    try {
      replica.read(chain.checkpoint);
      for (const response of chain.deltas) replica.read(response);
      current();
      const read = replica.view!;
      if (chain.version && read.version !== chain.version) throw Error('缓存会话增量版本不匹配。');
      return read;
    } finally {
      replica.dispose();
    }
  }
  close() {
    this.backend.close?.();
  }
}
