import type { AttachmentAction, AttachmentReceipt } from '@moor/protocol/attachment-protocol';
import type { ForkReceipt, SessionFork } from '@moor/protocol/fork-protocol';
import type { GitAction, GitActionReceipt } from '@moor/protocol/git-protocol';
import type { GithubAction, GithubReceipt } from '@moor/protocol/github-protocol';
import type { GithubWriteAction } from '@moor/protocol/github-write-protocol';
import type {
  QuestionAnswer,
  QuestionReceipt,
  SteerReceipt,
  SteerRequest,
} from '@moor/protocol/interaction-protocol';
import type { PreviewAction } from '@moor/protocol/preview-protocol';
import { type Mutation, type SessionAction } from '@moor/protocol/protocol';
import type { SessionControlAction } from '@moor/protocol/session-control-protocol';
import type { RespondPermission, SendTurn } from '@moor/protocol/session-intent-protocol';
export type JournalOperation =
  | SessionControlAction
  | Mutation
  | SendTurn
  | RespondPermission
  | SessionAction
  | AttachmentAction
  | QuestionAnswer
  | SteerRequest
  | GitAction
  | SessionFork
  | GithubAction
  | GithubWriteAction
  | PreviewAction;
/** Original-operation records and receipts. The caller supplies its complete authenticated scope. */
export interface OperationJournal {
  unfinishedGithubWrites(): { id: string; approval: string | null; result: string | null }[];
  stageOriginal(
    scope: string,
    original: JournalOperation,
    phase: string,
    turnId: string | null,
    result: unknown,
    plan?: unknown,
  ): void;
  settleOriginal(
    scope: string,
    original: JournalOperation,
    phase: string,
    result: unknown,
    expectedPhase?: string,
  ): void;
  updatePlan(scope: string, original: JournalOperation, plan: unknown): void;
  has(id: string): boolean;
  fingerprint(workspace: string, m: JournalOperation, binding?: unknown): string;
  lookup(workspace: string, m: JournalOperation, binding?: unknown): any;
  stage(
    workspace: string,
    m: Mutation | SendTurn | RespondPermission,
    turnId: string,
    approval?: unknown,
    binding?: unknown,
  ): void;
  accept(m: Mutation | SendTurn | RespondPermission): {
    accepted: true;
    delivered: true;
    operationId: string;
  };
  acceptGithub(scope: string, action: GithubAction, result: GithubReceipt): GithubReceipt;
  abandonGithub(scope: string, action: GithubAction, result: GithubReceipt): GithubReceipt;
  acceptSessionAction(
    workspace: string,
    action: SessionAction,
    meta: Record<string, unknown>,
  ): { accepted: boolean; delivered: boolean; operationId: string; meta: Record<string, unknown> };
  acceptAttachmentAction(
    workspace: string,
    action: AttachmentAction,
    result: AttachmentReceipt,
  ): AttachmentReceipt;
  acceptQuestion(
    workspace: string,
    answer: QuestionAnswer,
    result: QuestionReceipt,
  ): QuestionReceipt;
  stageSteer(workspace: string, request: SteerRequest): void;
  settleSteer(
    workspace: string,
    request: SteerRequest,
    phase: 'accepted' | 'steer-unknown' | 'steer-rejected',
    result: SteerReceipt | { message: string },
  ): SteerReceipt | { message: string };
  stageGit(scope: string, action: GitAction, plan: unknown): void;
  settleGit(scope: string, action: GitAction, result: GitActionReceipt): GitActionReceipt;
  close(): void;
  stageFork(scope: string, request: SessionFork): void;
  settleFork(scope: string, request: SessionFork, result: ForkReceipt): void;
}
