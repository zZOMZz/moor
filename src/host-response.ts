import type { HostCommand, HostCommandMethod } from './bridge/host-command';
import { AppError, agentSchema, runtimeWorkspaceSchema, type RuntimeWorkspace } from './protocol';
import {
  SESSION_RESPONSE_LIMITS,
  sessionListSchema,
  sessionReadResponseSchema,
  mutationReceiptSchema,
  sessionCancelReceiptSchema,
  validateSessionActionReceipt,
  validateSessionBundle,
  type SessionMetadata,
} from './session-responses';
import {
  FILE_CONTENT_FEATURE,
  isCanonicalBase64,
  projectFileResultSchema,
} from './content-protocol';
import {
  ATTACHMENTS_FEATURE,
  attachmentReceiptSchema,
  attachmentContentSchema,
} from './attachment-protocol';
import {
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
  projectTreeResultSchema,
  projectTurnDiffResultSchema,
  projectDiffFileResultSchema,
} from './project-content-protocol';
import {
  QUESTIONS_FEATURE,
  STEER_FEATURE,
  questionReceiptSchema,
  steerReceiptSchema,
} from './interaction-protocol';
import { SESSION_SEARCH_FEATURE, sessionSearchResultSchema } from './search-protocol';
import { GIT_WORKTREE_FEATURE, gitStateResultSchema, gitActionReceiptSchema } from './git-protocol';
import { SESSION_FORK_FEATURE, forkOptionsResultSchema, forkReceiptSchema } from './fork-protocol';
import { GITHUB_FEATURE, githubReadResultSchema, githubReceiptSchema } from './github-protocol';
import {
  GITHUB_WRITE_FEATURE,
  githubWriteReadResultSchema,
  githubWriteReceiptSchema,
} from './github-write-protocol';
import {
  PREVIEW_FEATURE,
  previewReadResultSchema,
  previewReceiptSchema,
  type PreviewFrame,
} from './preview-protocol';
import { SKILLS_FEATURE, validateSkillsRead } from './skills-protocol';
import {
  ROLE_FEATURE,
  ROLE_LIMITS,
  validateRolesRead,
  validateRoleReceipt,
  validateRolesInspect,
} from './role-protocol';
import { MCP_FEATURE, MCP_LIMITS, validateMcpRead } from './mcp-protocol';
import {
  SESSION_CONTROL_FEATURE,
  SESSION_CONTROL_LIMITS,
  validateSessionControlReceipt,
  validateSessionOperationResult,
} from './session-control-protocol';
import {
  SESSION_TASKS_FEATURE,
  TASK_LIMITS,
  validateTaskReadResult,
  validateTaskActionResult,
} from './task-protocol';

export const HOST_RESPONSE_FAILED = '主机响应不可验证，请手动重新读取或核查原操作';
const KiB = 1024,
  MiB = 1024 * KiB;
// Limits apply to the received value before schemas can strip any private fields.
const policies = {
  sessions: [undefined, SESSION_RESPONSE_LIMITS.listBytes],
  'agent-options': [undefined, 16 * MiB],
  session: [undefined, SESSION_RESPONSE_LIMITS.readBytes],
  'roles-read': [ROLE_FEATURE, ROLE_LIMITS.responseBytes],
  'mcp-read': [MCP_FEATURE, MCP_LIMITS.responseBytes],
  'session-control': [SESSION_CONTROL_FEATURE, SESSION_CONTROL_LIMITS.responseBytes],
  'session-operations': [SESSION_CONTROL_FEATURE, SESSION_CONTROL_LIMITS.responseBytes],
  'tasks-read': [SESSION_TASKS_FEATURE, TASK_LIMITS.responseBytes],
  'tasks-action': [SESSION_TASKS_FEATURE, TASK_LIMITS.responseBytes],
  'roles-action': [ROLE_FEATURE, ROLE_LIMITS.responseBytes],
  'skills-read': [SKILLS_FEATURE, 2 * MiB],
  'preview-read': [PREVIEW_FEATURE, 6 * MiB],
  'preview-action': [PREVIEW_FEATURE, 6 * MiB],
  'preview-inspect': [PREVIEW_FEATURE, 6 * MiB],
  'preview-close': [PREVIEW_FEATURE, 6 * MiB],
  'github-write-read': [GITHUB_WRITE_FEATURE, 3 * MiB],
  'github-write-action': [GITHUB_WRITE_FEATURE, 16 * KiB],
  'github-write-inspect': [GITHUB_WRITE_FEATURE, 16 * KiB],
  'github-write-abandon': [GITHUB_WRITE_FEATURE, 16 * KiB],
  'github-read': [GITHUB_FEATURE, 2 * MiB],
  'github-action': [GITHUB_FEATURE, 2 * MiB],
  'github-abandon': [GITHUB_FEATURE, 2 * MiB],
  mutate: [undefined, SESSION_RESPONSE_LIMITS.receiptBytes],
  'session-action': [undefined, SESSION_RESPONSE_LIMITS.receiptBytes],
  'file-content': [FILE_CONTENT_FEATURE, 2 * MiB],
  'attachment-action': [ATTACHMENTS_FEATURE, 64 * KiB],
  'read-attachment': [ATTACHMENTS_FEATURE, 12 * MiB],
  'read-project-tree': [PROJECT_TREE_FEATURE, 16 * MiB],
  'read-turn-diff': [PROJECT_DIFF_FEATURE, 48 * MiB],
  'read-diff-file': [PROJECT_DIFF_FEATURE, 16 * MiB],
  'answer-question': [QUESTIONS_FEATURE, 64 * KiB],
  steer: [STEER_FEATURE, 64 * KiB],
  'search-sessions': [SESSION_SEARCH_FEATURE, 2 * MiB],
  'git-state': [GIT_WORKTREE_FEATURE, 2 * MiB],
  'git-action': [GIT_WORKTREE_FEATURE, 2 * MiB],
  'fork-options': [SESSION_FORK_FEATURE, 2 * MiB],
  'fork-action': [SESSION_FORK_FEATURE, 2 * MiB],
  cancel: [undefined, SESSION_RESPONSE_LIMITS.receiptBytes],
} satisfies Record<HostCommandMethod, readonly [string | undefined, number]>;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new AppError(502, HOST_RESPONSE_FAILED);
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
function scope(
  result: { workspaceId: string; localProjectId: string; sessionId: string },
  input: { workspaceId: string; localProjectId: string; sessionId: string },
) {
  requireValue(
    result.workspaceId === input.workspaceId &&
      result.localProjectId === input.localProjectId &&
      result.sessionId === input.sessionId,
  );
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/**
 * Validate a decrypted success value before any cache, CRDT import or delivery update.
 * The transport must supply its authenticated catalog snapshot and current lease;
 * this function does not authenticate the host or treat a relay catalog as authority.
 * Error envelopes and encrypted-record correlation are separate transport checks.
 */
export async function validateHostResponse(
  raw: unknown,
  context: {
    command: HostCommand;
    workspace: RuntimeWorkspace;
    current?: () => void;
  },
): Promise<unknown> {
  try {
    const current = context.current ?? (() => {});
    current();
    const command = structuredClone(context.command),
      workspace = runtimeWorkspaceSchema.parse(context.workspace);
    const policy = policies[command.method];
    requireValue(
      policy &&
        workspace.id === command.workspaceId &&
        new Set(workspace.projects.map((p) => p.id)).size === workspace.projects.length &&
        new Set(workspace.agents.map((a) => a.id)).size === workspace.agents.length &&
        (!command.localProjectId ||
          workspace.projects.some((p) => p.id === command.localProjectId)) &&
        (!policy[0] || workspace.features?.includes(policy[0])),
    );
    const json = JSON.stringify(raw);
    requireValue(typeof json === 'string' && new TextEncoder().encode(json).length <= policy[1]);
    // Keep caller-owned values from changing during WebCrypto awaits. No parsed
    // response or original request reference is returned to caller-owned objects.
    raw = structuredClone(raw);
    const outer = command.params as Record<string, unknown>;
    const original = ('workspaceId' in outer ? outer : (outer.request ?? outer)) as Record<
      string,
      unknown
    >;
    if ('workspaceId' in original) requireValue(original.workspaceId === command.workspaceId);
    if ('localProjectId' in original)
      requireValue(
        workspace.projects.some((p) => p.id === original.localProjectId) &&
          (!command.localProjectId || original.localProjectId === command.localProjectId),
      );
    if ('userId' in original)
      requireValue(
        original.userId === workspace.userId && original.machineId === workspace.machineId,
      );
    const metadata = (meta: SessionMetadata) => {
      requireValue(
        meta.userId === workspace.userId &&
          meta.machineId === workspace.machineId &&
          workspace.projects.some((p) => p.id === meta.project.localProjectId) &&
          (!command.localProjectId || meta.project.localProjectId === command.localProjectId) &&
          (!original.sessionId || meta.id === original.sessionId),
      );
      const agent = workspace.agents.find((a) => a.id === meta.agentConfigId);
      // Historical sessions can retain a no-longer-selected Agent version.
      requireValue(
        !agent || (meta.cliType === agent.cliType && meta.agentType === agent.agentType),
      );
    };
    const sha = async (bytes: Uint8Array) => {
      current();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
      current();
      return 'sha256:' + [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const textSha = (value: string) => sha(new TextEncoder().encode(value));
    const image = async (frame: PreviewFrame) => {
      const bytes = decode(frame.image.data);
      requireValue(
        bytes.length >= 24 &&
          bytes.length === frame.image.byteLength &&
          [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) &&
          [73, 72, 68, 82].every((byte, i) => bytes[i + 12] === byte),
      );
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      requireValue(
        view.getUint32(16) === frame.viewport.width &&
          view.getUint32(20) === frame.viewport.height &&
          (await sha(bytes)) === frame.image.version,
      );
    };
    const result = await (async (): Promise<unknown> => {
      switch (command.method) {
        case 'sessions': {
          const result = sessionListSchema.parse(raw);
          requireValue(new Set(result.map((meta) => meta.id)).size === result.length);
          result.forEach(metadata);
          return result;
        }
        case 'session': {
          const result = sessionReadResponseSchema.parse(raw);
          requireValue(isCanonicalBase64(result.update));
          metadata(result.meta);
          validateSessionBundle(result);
          requireValue(
            !result.agent ||
              (result.agent.id === result.meta.agentConfigId &&
                result.agent.cliType === result.meta.cliType &&
                result.agent.agentType === result.meta.agentType),
          );
          return result;
        }
        case 'agent-options': {
          const result = agentSchema.parse(raw),
            selected = workspace.agents.find((a) => a.id === command.params.agentId);
          requireValue(
            (command.params.sessionId || selected) &&
              result.id === command.params.agentId &&
              (!selected ||
                (result.cliType === selected.cliType && result.agentType === selected.agentType)),
          );
          return result;
        }
        case 'mutate': {
          const result = mutationReceiptSchema.parse(raw);
          requireValue(result.operationId === command.params.operationId);
          return result;
        }
        case 'session-action': {
          const result = validateSessionActionReceipt(command.params, raw);
          if (result.accepted) metadata(result.meta);
          return result;
        }
        case 'cancel':
          return sessionCancelReceiptSchema.parse(raw);
        case 'roles-read':
          return validateRolesRead(raw, command.params);
        case 'mcp-read':
          return validateMcpRead(raw, command.params);
        case 'session-control':
          return validateSessionControlReceipt(raw, command.params, {
            kind: 'control',
            value: command.params,
          });
        case 'session-operations':
          return validateSessionOperationResult(raw, command.params);
        case 'tasks-read':
          return validateTaskReadResult(raw, command.params);
        case 'tasks-action':
          return validateTaskActionResult(raw, command.params);
        case 'roles-action': {
          const input = command.params;
          return input.action === 'inspect'
            ? validateRolesInspect(raw, input.request)
            : validateRoleReceipt(raw, input.action === 'abandon' ? input.request : input);
        }
        case 'skills-read': {
          const result = validateSkillsRead(raw, command.params);
          if (result.view === 'detail')
            requireValue((await textSha(result.text)) === result.skill.version);
          return result;
        }
        case 'file-content': {
          const result = projectFileResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.path === input.path);
          if (result.status === 'not-modified')
            requireValue(result.content.version === input.knownVersion);
          else requireValue((await sha(decode(result.data))) === result.content.version);
          return result;
        }
        case 'attachment-action': {
          const result = attachmentReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.operationId === input.operationId);
          if (input.action === 'upload') {
            requireValue(same(result.attachment, input.attachment));
            requireValue((await sha(decode(input.data))) === input.attachment.content.version);
          } else requireValue(result.removed === true);
          return result;
        }
        case 'read-attachment': {
          const result = attachmentContentSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.attachment.attachmentId === input.attachmentId &&
              (await sha(decode(result.data))) === result.attachment.content.version,
          );
          return result;
        }
        case 'read-project-tree': {
          const result = projectTreeResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.offset === (input.offset ?? 0) &&
              result.entries.length <= (input.limit ?? 200) &&
              (!input.knownVersion || result.version === input.knownVersion),
          );
          return result;
        }
        case 'read-turn-diff': {
          const result = projectTurnDiffResultSchema.parse(raw);
          scope(result, command.params);
          requireValue(result.turnId === command.params.turnId);
          return result;
        }
        case 'read-diff-file': {
          const result = projectDiffFileResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.turnId === input.turnId &&
              result.path === input.path &&
              (!input.knownVersion || result.reference.version === input.knownVersion),
          );
          for (const file of [result.before, result.after])
            if (file?.state === 'text') requireValue((await textSha(file.text!)) === file.version);
          return result;
        }
        case 'answer-question': {
          const result = questionReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.expectedTurnId === input.expectedTurnId &&
              result.operationId === input.operationId &&
              result.requestId === input.requestId,
          );
          return result;
        }
        case 'steer': {
          const result = steerReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.expectedTurnId === input.expectedTurnId &&
              result.operationId === input.operationId,
          );
          return result;
        }
        case 'search-sessions': {
          const result = sessionSearchResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.scope === input.scope &&
              result.query === input.query &&
              result.hits.length <= input.limit &&
              (input.scope !== 'session' ||
                result.hits.every((hit) => hit.sessionId === input.sessionId)),
          );
          return result;
        }
        case 'git-state': {
          const result = gitStateResultSchema.parse(raw);
          scope(result, command.params);
          return result;
        }
        case 'git-action': {
          const result = gitActionReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.operationId === input.operationId);
          if (result.phase === 'accepted') {
            requireValue(
              result.execution.revision === input.expectedRevision + 1 &&
                result.execution.mode === 'worktree',
            );
            requireValue(
              input.action === 'prepare'
                ? result.execution.status === 'ready' &&
                    result.execution.branch === input.newBranch &&
                    result.execution.baseOid === input.expectedOid
                : result.execution.status === 'removed' &&
                    result.execution.executionId === input.executionId &&
                    (input.action === 'detach'
                      ? result.execution.disposition === 'detached'
                      : result.execution.disposition !== 'detached'),
            );
          }
          return result;
        }
        case 'fork-options': {
          const result = forkOptionsResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            !input.turnId ||
              (result.turns.length === 1 && result.turns[0]?.turnId === input.turnId),
          );
          requireValue(
            new Set(result.turns.map((turn) => turn.turnId)).size === result.turns.length,
          );
          const agent = workspace.agents.find((item) => item.id === result.agent.id);
          requireValue(!agent || agent.agentType === result.agent.agentType);
          return result;
        }
        case 'fork-action': {
          const result = forkReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.operationId === input.operationId &&
              result.childSessionId === input.childSessionId,
          );
          if (result.origin)
            requireValue(
              result.origin.sourceSessionId === input.sessionId &&
                result.origin.sourceVersion === input.expectedSourceVersion &&
                same(result.origin.cutoff, input.cutoff) &&
                result.origin.directory === input.directory.kind,
            );
          if (result.phase === 'accepted') {
            const execution = result.execution!;
            requireValue(
              input.directory.kind === 'worktree'
                ? execution.mode === 'worktree' &&
                    execution.revision === 1 &&
                    execution.branch === input.directory.newBranch &&
                    execution.baseOid === input.directory.expectedOid &&
                    result.origin?.branch === input.directory.newBranch &&
                    result.origin?.baseOid === input.directory.expectedOid
                : execution.revision === input.expectedExecutionRevision &&
                    execution.mode ===
                      (input.expectedExecutionRevision === 0 ? 'shared' : 'worktree'),
            );
          }
          return result;
        }
        case 'github-read': {
          const result = githubReadResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.view === input.view);
          if (input.view !== 'overview')
            requireValue(
              'repository' in result &&
                result.repository?.id === input.repositoryId &&
                result.configVersion === input.configVersion,
            );
          if ('page' in input)
            requireValue(
              ('result' in result && result.result.page === input.page) ||
                ('checks' in result &&
                  result.checks.page === input.page &&
                  result.statuses.page === input.page),
            );
          if (input.view === 'issues' || input.view === 'pulls')
            requireValue(
              'state' in result &&
                result.state === input.state &&
                'result' in result &&
                result.result.items.every(
                  (item) =>
                    'kind' in item && item.kind === (input.view === 'issues' ? 'issue' : 'pull'),
                ),
            );
          if (input.view === 'issue' || input.view === 'pull') {
            requireValue(
              'item' in result &&
                result.item.number === input.number &&
                result.item.kind === input.view,
            );
            if (result.item.kind === 'pull')
              requireValue(result.item.base.repository.id === result.repository.id);
          }
          if (input.view === 'comments')
            requireValue(
              'subject' in result &&
                result.subject === input.subject &&
                result.number === input.number,
            );
          if (input.view === 'checks')
            requireValue(
              'checks' in result &&
                result.number === input.number &&
                result.headSha === input.headSha,
            );
          return result;
        }
        case 'github-action':
        case 'github-abandon': {
          const result = githubReceiptSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(
            result.operationId === input.operationId &&
              result.binding.revision ===
                input.expectedRevision + ('abandoned' in result && result.abandoned ? 0 : 1),
          );
          if ('abandoned' in result && result.abandoned) requireValue(!result.binding.context);
          else if (input.action === 'unbind')
            requireValue(!result.binding.context && !('redacted' in result && result.redacted));
          else if (!('redacted' in result && result.redacted))
            requireValue(
              result.binding.context?.repository.id === input.repositoryId &&
                result.binding.context.branch === input.branch &&
                same(result.binding.context.subject, input.subject),
            );
          return result;
        }
        case 'github-write-read': {
          const result = githubWriteReadResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.view === input.view);
          if ('repositoryId' in input)
            requireValue(
              'repository' in result &&
                result.repository?.id === input.repositoryId &&
                result.configVersion === input.configVersion,
            );
          if ('page' in input)
            requireValue('result' in result && result.result.page === input.page);
          if (input.view === 'files' || input.view === 'review-comments')
            requireValue(
              'number' in result &&
                result.number === input.number &&
                result.headSha === input.headSha &&
                result.baseSha === input.baseSha,
            );
          if (input.view === 'push-preview')
            requireValue(
              result.view === 'push-preview' &&
                result.branch === input.branch &&
                result.headOid === input.headOid,
            );
          if (input.view === 'commit-preview')
            requireValue(
              result.view === 'commit-preview' &&
                result.files.length === input.paths.length &&
                new Set(result.files.map((file) => file.path)).size === result.files.length &&
                result.files.every((file) => input.paths.includes(file.path)),
            );
          return result;
        }
        case 'github-write-action':
        case 'github-write-inspect':
        case 'github-write-abandon': {
          const result = githubWriteReceiptSchema.parse(raw),
            input =
              command.method === 'github-write-action' ? command.params : command.params.request;
          scope(result, input);
          requireValue(
            result.operationId === input.operationId &&
              result.action === input.action &&
              result.requestVersion === (await textSha(JSON.stringify(input))),
          );
          if ('number' in input && result.result?.number !== undefined)
            requireValue(result.result.number === input.number);
          if (input.action === 'push' && result.result?.sha !== undefined)
            requireValue(result.result.sha === input.headOid);
          return result;
        }
        case 'preview-read': {
          const result = previewReadResultSchema.parse(raw),
            input = command.params;
          scope(result, input);
          requireValue(result.view === input.view);
          if (input.view !== 'options')
            requireValue(
              'clientId' in result &&
                result.clientId === input.clientId &&
                result.previewId === input.previewId,
            );
          if (input.view === 'locate')
            requireValue(
              result.view === 'locate' &&
                result.frameId === input.frameId &&
                (!result.element || result.element.frameId === input.frameId),
            );
          if (result.view === 'frame') {
            requireValue(result.frame.previewId === result.previewId);
            await image(result.frame);
          }
          if (result.view === 'options')
            requireValue(
              new Set(result.services.map((service) => service.id)).size === result.services.length,
            );
          return result;
        }
        case 'preview-action':
        case 'preview-inspect':
        case 'preview-close': {
          const result = previewReceiptSchema.parse(raw),
            input = command.method === 'preview-action' ? command.params : command.params.request;
          scope(result, input);
          requireValue(
            result.operationId === input.operationId &&
              result.clientId === input.clientId &&
              result.action === input.action &&
              result.requestVersion === (await textSha(JSON.stringify(input))),
          );
          if (input.action !== 'open')
            requireValue(!result.previewId || result.previewId === input.previewId);
          if (command.method === 'preview-close')
            requireValue(result.closed && result.phase === 'closed');
          if (result.frame) {
            requireValue(result.frame.previewId === result.previewId);
            if (input.action === 'open' || input.action === 'resize')
              requireValue(same(result.frame.viewport, input.viewport));
            await image(result.frame);
          }
          return result;
        }
        default: {
          const exhaustive: never = command;
          void exhaustive;
          throw new AppError(502, HOST_RESPONSE_FAILED);
        }
      }
    })();
    current();
    return result;
  } catch {
    // A malformed response is never evidence that an operation was rejected or safe to replay.
    throw new AppError(502, HOST_RESPONSE_FAILED);
  }
}
