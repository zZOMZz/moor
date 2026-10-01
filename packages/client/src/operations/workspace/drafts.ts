import type { StorageBackend } from '@moor/client/operations/storage';
import { actorSchema, type AttentionActor } from '@moor/protocol/attention';
import { type RunSelection } from '@moor/protocol/run-config';
import type { WorkspaceLedgerPersistence } from './ledger';
import {
  conflict,
  draftDocumentSchema,
  draftKeyFor,
  draftSchema,
  emptyDraft,
  same,
  scopeSchema,
  WorkspaceDraft,
  WorkspaceLedger,
  WorkspaceScope,
} from './model';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceDraftsPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'records'>;
}
export class WorkspaceDraftsPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceDraftsPersistencePorts,
  ) {}
  async migrateDraft(
    scope: WorkspaceScope,
    sessionId: string,
    draft: WorkspaceDraft,
    current: () => void,
  ) {
    const key = draftKeyFor(scope, sessionId);
    await this.backend.exclusive(key, current, async () => {
      const raw = await this.backend.read(key);
      current();
      if (raw !== null) {
        this.parseDraftDocument(scope, sessionId, raw);
        return;
      }
      const document = draftDocumentSchema.parse({
        version: 1,
        scope,
        sessionId,
        value: draft,
      });
      await this.backend.compareAndSet(key, null, document, current);
      current();
    });
  }
  parseDraftDocument(scope: WorkspaceScope, sessionId: string, raw: unknown) {
    const document = draftDocumentSchema.parse(raw);
    if (!same(document.scope, scope) || document.sessionId !== sessionId) throw conflict();
    if (document.value.actor && document.value.actor.accountId !== scope.target.owner)
      throw Error('草稿账号与原范围不匹配。');
    return document;
  }
  async readDraft(
    scope: WorkspaceScope,
    sessionId: string,
    current: () => void,
    ledger?: WorkspaceLedger,
  ): Promise<WorkspaceDraft> {
    const normalized = scopeSchema.parse(scope),
      key = draftKeyFor(normalized, sessionId);
    current();
    const raw = await this.backend.read(key);
    current();
    let draft =
      raw === null
        ? emptyDraft()
        : structuredClone(this.parseDraftDocument(normalized, sessionId, raw).value);
    // Draft cleanup is intentionally eventual and separate from the reliable
    // receipt transaction. Re-reading a confirmed operation completes cleanup
    // without ever clearing text edited after that operation was staged.
    for (;;) {
      const confirmed = ledger?.operations.find(
        (entry) =>
          entry.status === 'confirmed' &&
          entry.draft?.sessionId === sessionId &&
          entry.draft.revision === draft.revision,
      );
      const confirmedRevision = confirmed
        ? draft.revision
        : await this.ports.ledger.records.confirmedDraft(normalized, sessionId, current);
      if (confirmedRevision !== draft.revision) return draft;
      try {
        draft = await this.clearDraft(normalized, sessionId, draft.revision, current);
      } catch {
        // Ledger confirmation is authoritative. Draft cleanup is recoverable
        // and must never turn an accepted operation back into an unknown one.
        current();
        return draft;
      }
    }
  }
  async saveDraft(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    text: string,
    selection: RunSelection,
    current: () => void,
    actor?: AttentionActor,
  ) {
    const normalized = scopeSchema.parse(scope);
    if (actor && actorSchema.parse(actor).accountId !== normalized.target.owner)
      throw Error('草稿账号与原范围不匹配。');
    const key = draftKeyFor(normalized, sessionId);
    return this.backend.exclusive(key, current, async () => {
      const raw = await this.backend.read(key);
      current();
      const previous =
        raw === null ? emptyDraft() : this.parseDraftDocument(normalized, sessionId, raw).value;
      if (previous.revision !== expectedRevision) throw conflict();
      const draft = draftSchema.parse({
        revision: previous.revision + 1,
        text,
        selection,
        ...(actor ? { actor } : {}),
      });
      const document = draftDocumentSchema.parse({
        version: 1,
        scope: normalized,
        sessionId,
        value: draft,
      });
      await this.backend.compareAndSet(key, raw, document, current);
      current();
      return structuredClone(draft);
    });
  }
  async clearDraft(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    current: () => void,
  ) {
    const normalized = scopeSchema.parse(scope),
      key = draftKeyFor(normalized, sessionId);
    return this.backend.exclusive(key, current, async () => {
      const raw = await this.backend.read(key);
      current();
      const previous =
        raw === null ? emptyDraft() : this.parseDraftDocument(normalized, sessionId, raw).value;
      if (previous.revision !== expectedRevision) return structuredClone(previous);
      const draft = draftSchema.parse({
        ...previous,
        revision: previous.revision + 1,
        text: '',
      });
      const document = draftDocumentSchema.parse({
        version: 1,
        scope: normalized,
        sessionId,
        value: draft,
      });
      await this.backend.compareAndSet(key, raw, document, current);
      current();
      return structuredClone(draft);
    });
  }
}
