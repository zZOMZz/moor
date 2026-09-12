import { z } from 'zod';
import { AppError, assert, id, mutationSchema, sessionActionSchema } from '../protocol';
import type { HostWorkspace } from './host-workspace';
import { sessionBase64Schema, sessionCancelSchema } from '../session-responses';
import { projectFileReadSchema } from '../content-protocol';
import { attachmentActionSchema, attachmentReadSchema } from '../attachment-protocol';
import {
  projectTreeReadSchema,
  projectTurnDiffReadSchema,
  projectDiffFileReadSchema,
} from '../project-content-protocol';
import { questionAnswerSchema, steerRequestSchema } from '../interaction-protocol';
import { sessionSearchRequestSchema } from '../search-protocol';
import { gitStateReadSchema, gitActionSchema } from '../git-protocol';
import { forkOptionsReadSchema, sessionForkSchema } from '../fork-protocol';
import { githubReadSchema, githubActionSchema } from '../github-protocol';
import {
  githubWriteReadSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
} from '../github-write-protocol';
import { mcpReadSchema } from '../mcp-protocol';
import { sessionControlActionSchema, sessionOperationSchema } from '../session-control-protocol';
import { taskReadSchema, taskActionSchema, type TaskAuthorityLease } from '../task-protocol';
import { skillsReadSchema } from '../skills-protocol';
import { rolesReadSchema, rolesActionRequestSchema } from '../role-protocol';
import {
  previewReadSchema,
  previewActionSchema,
  previewInspectSchema,
  previewCloseSchema,
} from '../preview-protocol';

// This is the existing execution surface, not a list of safe-to-retry reads.
// agent-options opens ACP and persists capabilities. Metadata and recovery operations
// can have unknown delivery outcomes and retain their original operation identity.
export const HOST_COMMAND_METHODS = [
  'sessions',
  'agent-options',
  'session',
  'roles-read',
  'mcp-read',
  'session-control',
  'session-operations',
  'tasks-read',
  'tasks-action',
  'roles-action',
  'skills-read',
  'preview-read',
  'preview-action',
  'preview-inspect',
  'preview-close',
  'github-write-read',
  'github-write-action',
  'github-write-inspect',
  'github-write-abandon',
  'github-read',
  'github-action',
  'github-abandon',
  'mutate',
  'session-action',
  'file-content',
  'attachment-action',
  'read-attachment',
  'read-project-tree',
  'read-turn-diff',
  'read-diff-file',
  'answer-question',
  'steer',
  'search-sessions',
  'git-state',
  'git-action',
  'fork-options',
  'fork-action',
  'cancel',
] as const;
export type HostCommandMethod = (typeof HOST_COMMAND_METHODS)[number];
export const hostCommandSchemas = {
  sessions: z.object({}).strict(),
  'agent-options': z.object({ agentId: id, sessionId: id.optional() }).strict(),
  session: z
    .object({
      sessionId: id,
      version: sessionBase64Schema.refine((value) => value.length <= 64 * 1024).optional(),
    })
    .strict(),
  'roles-read': rolesReadSchema,
  'mcp-read': mcpReadSchema,
  'session-control': sessionControlActionSchema,
  'session-operations': sessionOperationSchema,
  'tasks-read': taskReadSchema,
  'tasks-action': taskActionSchema,
  'roles-action': rolesActionRequestSchema,
  'skills-read': skillsReadSchema,
  'preview-read': previewReadSchema,
  'preview-action': previewActionSchema,
  'preview-inspect': previewInspectSchema,
  'preview-close': previewCloseSchema,
  'github-write-read': githubWriteReadSchema,
  'github-write-action': githubWriteActionSchema,
  'github-write-inspect': githubWriteInspectSchema,
  'github-write-abandon': githubWriteAbandonSchema,
  'github-read': githubReadSchema,
  'github-action': githubActionSchema,
  'github-abandon': githubActionSchema,
  mutate: mutationSchema,
  'session-action': sessionActionSchema,
  'file-content': projectFileReadSchema,
  'attachment-action': attachmentActionSchema,
  'read-attachment': attachmentReadSchema,
  'read-project-tree': projectTreeReadSchema,
  'read-turn-diff': projectTurnDiffReadSchema,
  'read-diff-file': projectDiffFileReadSchema,
  'answer-question': questionAnswerSchema,
  steer: steerRequestSchema,
  'search-sessions': sessionSearchRequestSchema,
  'git-state': gitStateReadSchema,
  'git-action': gitActionSchema,
  'fork-options': forkOptionsReadSchema,
  'fork-action': sessionForkSchema,
  cancel: sessionCancelSchema,
} satisfies Record<HostCommandMethod, z.ZodTypeAny>;

type CommandScope = { workspaceId: string; localProjectId?: string };
export type HostCommand = {
  [M in HostCommandMethod]: CommandScope & {
    method: M;
    params: z.output<(typeof hostCommandSchemas)[M]>;
  };
}[HostCommandMethod];
export type HostCommandInput = {
  [M in HostCommandMethod]: CommandScope & {
    method: M;
    params: z.input<(typeof hostCommandSchemas)[M]>;
  };
}[HostCommandMethod];
export const hostCommandSchema = z
  .object({
    method: z.enum(HOST_COMMAND_METHODS),
    workspaceId: id,
    localProjectId: id.optional(),
    params: z.unknown(),
  })
  .strict()
  .transform((command, context): HostCommand => {
    const parsed = hostCommandSchemas[command.method].safeParse(command.params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({ ...issue, path: ['params', ...issue.path] });
      return z.NEVER;
    }
    return { ...command, params: parsed.data } as HostCommand;
  });

// Type-only picks avoid importing the execution runtime, relay or transports.
export type HostCommandWorkspace = Pick<
  HostWorkspace,
  | 'closed'
  | 'list'
  | 'refreshAgentOptions'
  | 'read'
  | 'readRoles'
  | 'readMcp'
  | 'roleAction'
  | 'readSkills'
  | 'readPreview'
  | 'previewAction'
  | 'inspectPreview'
  | 'closePreview'
  | 'readGithubWrite'
  | 'githubWriteAction'
  | 'inspectGithubWrite'
  | 'abandonGithubWrite'
  | 'readGithub'
  | 'abandonGithub'
  | 'githubAction'
  | 'mutate'
  | 'sessionAction'
  | 'readProjectFile'
  | 'attachmentAction'
  | 'readAttachment'
  | 'readProjectTree'
  | 'readTurnDiff'
  | 'readDiffFile'
  | 'answerQuestion'
  | 'steer'
  | 'searchSessions'
  | 'readGitState'
  | 'gitAction'
  | 'readForkOptions'
  | 'forkSession'
  | 'cancel'
> & {
  controlManager: Pick<HostWorkspace['controlManager'], 'control' | 'recover'>;
  taskManager: Pick<HostWorkspace['taskManager'], 'read' | 'action'>;
};
export interface HostCommandDependencies {
  ready(): boolean;
  workspace(id: string): HostCommandWorkspace | undefined;
  hasOperation(operationId: string): boolean;
}
export interface HostCommandContext {
  // Construct only from an authenticated connection; never take authority from params.
  authority?: TaskAuthorityLease;
  // Optional entry guard for verified transports. Delivery checks remain with the caller.
  current?(): void;
}
export type HostCommandError = { status: number; message: string; rejected: boolean };
const rejectionMethods: readonly string[] = [
  'mutate',
  'session-action',
  'attachment-action',
  'git-action',
  'fork-action',
  'github-action',
  'github-abandon',
  'github-write-action',
  'preview-action',
];
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Shared execution only. Response validation and transport encryption belong to their boundaries. */
export class HostCommandDispatcher {
  constructor(private readonly dependencies: HostCommandDependencies) {}
  async execute(raw: unknown, context: HostCommandContext = {}): Promise<unknown> {
    const method = record(raw)?.method;
    if (typeof method === 'string' && !HOST_COMMAND_METHODS.includes(method as HostCommandMethod))
      throw new AppError(400, '不支持的操作');
    const command = hostCommandSchema.parse(raw);
    context.current?.();
    const workspace = this.dependencies.workspace(command.workspaceId);
    assert(this.dependencies.ready() && workspace && !workspace.closed, 409, '本机执行服务不可达');
    let result: unknown;
    if (command.method === 'sessions') result = workspace.list(command.localProjectId);
    else if (command.method === 'agent-options')
      result = await workspace.refreshAgentOptions(
        command.params.agentId,
        command.localProjectId,
        command.params.sessionId,
      );
    else if (command.method === 'session')
      result = await workspace.read(
        command.params.sessionId,
        command.params.version,
        command.localProjectId,
      );
    else if (command.method === 'roles-read')
      result = await workspace.readRoles(command.params, command.localProjectId);
    else if (command.method === 'mcp-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = workspace.readMcp(input, command.localProjectId);
    } else if (command.method === 'session-control')
      result = await workspace.controlManager.control(command.params, command.localProjectId);
    else if (command.method === 'session-operations')
      result = await workspace.controlManager.recover(command.params, command.localProjectId);
    else if (command.method === 'tasks-read')
      result = await workspace.taskManager.read(command.params, command.localProjectId);
    else if (command.method === 'tasks-action')
      result = await workspace.taskManager.action(command.params, command.localProjectId);
    else if (command.method === 'roles-action')
      result = await workspace.roleAction(command.params, command.localProjectId);
    else if (command.method === 'skills-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readSkills(input, command.localProjectId);
    } else if (command.method === 'preview-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readPreview(input, command.localProjectId);
    } else if (command.method === 'preview-action') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.previewAction(input, command.localProjectId);
    } else if (command.method === 'preview-inspect') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.inspectPreview(input, command.localProjectId);
    } else if (command.method === 'preview-close') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.closePreview(input, command.localProjectId);
    } else if (command.method === 'github-write-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readGithubWrite(input, command.localProjectId);
    } else if (command.method === 'github-write-action') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.githubWriteAction(input, command.localProjectId);
    } else if (command.method === 'github-write-inspect') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.inspectGithubWrite(input, command.localProjectId);
    } else if (command.method === 'github-write-abandon') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.abandonGithubWrite(input, command.localProjectId);
    } else if (command.method === 'github-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readGithub(input, command.localProjectId);
    } else if (command.method === 'github-action' || command.method === 'github-abandon') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await (command.method === 'github-abandon'
        ? workspace.abandonGithub(input, command.localProjectId)
        : workspace.githubAction(input, command.localProjectId));
    } else if (command.method === 'mutate') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.mutate(body, command.localProjectId, context.authority);
    } else if (command.method === 'session-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.sessionAction(body, command.localProjectId);
    } else if (command.method === 'file-content') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readProjectFile(body, command.localProjectId);
    } else if (command.method === 'attachment-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.attachmentAction(body, command.localProjectId);
    } else if (command.method === 'read-attachment') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readAttachment(body, command.localProjectId);
    } else if (command.method === 'read-project-tree') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readProjectTree(body, command.localProjectId);
    } else if (command.method === 'read-turn-diff') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readTurnDiff(body, command.localProjectId);
    } else if (command.method === 'read-diff-file') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readDiffFile(body, command.localProjectId);
    } else if (command.method === 'answer-question') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.answerQuestion(body, command.localProjectId);
    } else if (command.method === 'steer') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.steer(body, command.localProjectId);
    } else if (command.method === 'search-sessions') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.searchSessions(body, command.localProjectId);
    } else if (command.method === 'git-state') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readGitState(body, command.localProjectId);
    } else if (command.method === 'git-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.gitAction(body, command.localProjectId);
    } else if (command.method === 'fork-options') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readForkOptions(body, command.localProjectId);
    } else if (command.method === 'fork-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.forkSession(body, command.localProjectId);
    } else if (command.method === 'cancel')
      result = await workspace.cancel(
        command.params.sessionId,
        command.params.turnId,
        command.localProjectId,
      );
    else throw new AppError(400, '不支持的操作');
    return result;
  }
  error(raw: unknown, error: unknown): HostCommandError {
    const command = record(raw),
      operationId = record(command?.params)?.operationId;
    return {
      status: error instanceof AppError ? error.status : 502,
      message: error instanceof AppError ? error.message : '本地主机处理失败',
      rejected:
        (error instanceof AppError && error.rejected) ||
        (typeof command?.method === 'string' &&
          rejectionMethods.includes(command.method) &&
          typeof operationId === 'string' &&
          !this.dependencies.hasOperation(operationId)),
    };
  }
}
