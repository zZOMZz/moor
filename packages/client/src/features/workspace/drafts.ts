import { type RunSelection } from '@moor/protocol/run-config';
import { WorkspacePersistence } from '../../operations/workspace/compose';
import type { WorkspaceContextService } from './context';
import type { WorkspaceInteractionsService } from './interactions';
import { BufferedDraft, Context, DRAFT_SAVE_DELAY_MS, same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by drafts use cases; supplied only by the workspace composition root. */
export interface WorkspaceDraftsPorts {
  context: Pick<WorkspaceContextService, 'value' | 'schedule' | 'closed' | 'current' | 'emit'>;
  interactions: Pick<WorkspaceInteractionsService, 'interactionWrites'>;
  store: Pick<WorkspacePersistence, 'saveDraft' | 'read' | 'readDraft'>;
  sessions: Pick<WorkspaceSessionsService, 'rememberSessionDraft'>;
}
export class WorkspaceDraftsService {
  constructor(readonly ports: WorkspaceDraftsPorts) {}
  draftWrites: Promise<void> = Promise.resolve();
  draftBuffer?: BufferedDraft;
  draftInput?: BufferedDraft;
  cancelDraftSave?: () => void;
  queueDraft(
    text: string,
    selection: RunSelection,
    failed?: (error: unknown) => void,
    saved?: () => void,
  ) {
    const scope = this.ports.context.value.scope,
      sessionId = this.ports.context.value.sessionId;
    if (!scope || !sessionId || !this.ports.context.value.draft) throw Error('请先打开会话。');
    this.draftInput = this.draftBuffer = {
      scope: structuredClone(scope),
      sessionId,
      text,
      selection: structuredClone(selection),
      actor: structuredClone(this.ports.context.value.catalogs[scope.source]?.actor),
      failed,
      saved,
    };
    this.cancelDraftSave?.();
    this.cancelDraftSave = this.ports.context.schedule(DRAFT_SAVE_DELAY_MS, () => {
      this.cancelDraftSave = undefined;
      void this.flushDraft().catch(() => {});
    });
  }
  async flushDraft() {
    this.cancelDraftSave?.();
    this.cancelDraftSave = undefined;
    for (;;) {
      const pending = this.draftBuffer;
      if (!pending) {
        const draftWrites = this.draftWrites,
          interactionWrites = this.ports.interactions.interactionWrites;
        await draftWrites;
        await interactionWrites;
        if (
          this.draftBuffer ||
          draftWrites !== this.draftWrites ||
          interactionWrites !== this.ports.interactions.interactionWrites
        )
          continue;
        return;
      }
      this.draftBuffer = undefined;
      const current = () => {
        if (
          this.ports.context.closed ||
          !same(this.ports.context.value.scope, pending.scope) ||
          this.ports.context.value.sessionId !== pending.sessionId
        )
          throw Error('当前电脑、项目或会话已改变，请重新读取。');
      };
      const write = this.draftWrites.then(async () => {
        current();
        const draft = this.ports.context.value.draft;
        if (!draft) throw Error('请先打开会话。');
        this.ports.context.value.draft = await this.ports.store.saveDraft(
          pending.scope,
          pending.sessionId,
          draft.revision,
          pending.text,
          pending.selection,
          current,
          pending.actor,
        );
        pending.committed = this.ports.context.value.draft;
        if (this.draftInput === pending) this.draftInput = undefined;
        this.ports.sessions.rememberSessionDraft(pending.scope, pending.sessionId);
        current();
      });
      // A failed recoverable draft write must not poison later explicit retries.
      this.draftWrites = write.catch(() => {});
      try {
        await write;
      } catch (error) {
        if (!this.draftBuffer) this.draftBuffer = pending;
        try {
          pending.failed?.(error);
        } catch {
          // UI notification callbacks never control persistence or retry state.
        }
        throw error;
      }
      try {
        pending.saved?.();
      } catch {
        // UI notification callbacks never control persistence or retry state.
      }
    }
  }
  saveDraft(text: string, selection: RunSelection) {
    this.queueDraft(text, selection);
    return this.flushDraft();
  }
  async reloadDraft() {
    const scope = this.ports.context.value.scope,
      sessionId = this.ports.context.value.sessionId,
      current = this.ports.context.current();
    if (!scope || !sessionId) throw Error('请先打开会话。');
    await this.flushDraft().catch(() => {});
    current();
    this.draftBuffer = undefined;
    this.draftInput = undefined;
    this.cancelDraftSave?.();
    this.cancelDraftSave = undefined;
    this.ports.context.value.ledger = await this.ports.store.read(scope, current, sessionId);
    this.ports.context.value.draft = await this.ports.store.readDraft(
      scope,
      sessionId,
      current,
      this.ports.context.value.ledger,
    );
    this.ports.sessions.rememberSessionDraft(scope, sessionId);
    this.draftWrites = Promise.resolve();
    this.ports.interactions.interactionWrites = Promise.resolve();
    this.ports.context.emit();
  }
  async reloadLedger(context: Context) {
    this.ports.context.value.ledger = await this.ports.store.read(
      context.scope,
      context.current,
      this.ports.context.value.sessionId ?? [],
    );
    if (this.ports.context.value.sessionId)
      this.ports.context.value.draft = await this.ports.store.readDraft(
        context.scope,
        this.ports.context.value.sessionId,
        context.current,
        this.ports.context.value.ledger,
      );
    if (this.ports.context.value.sessionId)
      this.ports.sessions.rememberSessionDraft(context.scope, this.ports.context.value.sessionId);
    this.ports.context.emit();
  }
  dispose() {
    this.cancelDraftSave?.();
    this.cancelDraftSave = undefined;
    this.draftBuffer = undefined;
    this.draftInput = undefined;
  }
}
