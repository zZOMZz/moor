import { AppError, assert } from '@moor/protocol/protocol';
import type { TaskAuthorityLease } from '@moor/protocol/task-protocol';
import type { HostWorkspace } from '../sessions/workspace';
import {
  HOST_COMMAND_METHODS,
  hostCommandSchemas,
  hostCommandSchema,
  type HostCommand,
  type HostCommandInput,
  type HostCommandMethod,
} from '@moor/protocol/host-command';
export { HOST_COMMAND_METHODS, hostCommandSchemas, hostCommandSchema };
export type { HostCommand, HostCommandInput, HostCommandMethod };

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
  | 'gitOperations'
  | 'readForkOptions'
  | 'forkSession'
  | 'forkOperations'
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
        command.params.modelId,
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
      result = await workspace.readPreview(input, command.localProjectId, context.authority);
    } else if (command.method === 'preview-action') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.previewAction(input, command.localProjectId, context.authority);
    } else if (command.method === 'preview-inspect') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.inspectPreview(input, command.localProjectId, context.authority);
    } else if (command.method === 'preview-close') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.closePreview(input, command.localProjectId, context.authority);
    } else if (command.method === 'github-write-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readGithubWrite(input, command.localProjectId, context.current);
    } else if (command.method === 'github-write-action') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.githubWriteAction(input, command.localProjectId, context.current);
    } else if (command.method === 'github-write-inspect') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.inspectGithubWrite(input, command.localProjectId, context.current);
    } else if (command.method === 'github-write-abandon') {
      const input = command.params;
      assert(input.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.abandonGithubWrite(input, command.localProjectId, context.current);
    } else if (command.method === 'github-read') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readGithub(input, command.localProjectId, context.current);
    } else if (command.method === 'github-action' || command.method === 'github-abandon') {
      const input = command.params;
      assert(input.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await (command.method === 'github-abandon'
        ? workspace.abandonGithub(input, command.localProjectId, context.current)
        : workspace.githubAction(input, command.localProjectId, context.current));
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
      result = await workspace.readGitState(body, command.localProjectId, context.current);
    } else if (command.method === 'git-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.gitAction(body, command.localProjectId, context.current);
    } else if (command.method === 'git-operations') {
      const body = command.params;
      assert(body.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.gitOperations(body, command.localProjectId, context.current);
    } else if (command.method === 'fork-options') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.readForkOptions(body, command.localProjectId, context.current);
    } else if (command.method === 'fork-action') {
      const body = command.params;
      assert(body.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.forkSession(body, command.localProjectId, context.current);
    } else if (command.method === 'fork-operations') {
      const body = command.params;
      assert(body.request.workspaceId === command.workspaceId, 400, '工作区不匹配');
      result = await workspace.forkOperations(body, command.localProjectId, context.current);
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
