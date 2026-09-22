import { SESSION_INTENTS_FEATURE, SESSION_INTENT_LIMITS } from './session-intent-protocol';
import { type HostCommand, type HostCommandMethod } from './host-command';
import { RETIRED_RECORDS_FEATURE, RETIRED_SESSION_FEATURE } from './connection-authority';
import { AppError, AGENT_MODEL_OPTIONS_FEATURE } from './protocol';
import { SESSION_PAGE_FEATURE, SESSION_PAGE_LIMITS } from './session-page';
import { SESSION_RESPONSE_LIMITS } from './session-responses';
import { AGENT_CONTROLS_FEATURE, AGENT_RUN_DEFAULTS_FEATURE } from './agent-controls';
import { FILE_CONTENT_FEATURE } from './content-protocol';
import { ATTACHMENTS_FEATURE } from './attachment-protocol';
import { PROJECT_TREE_FEATURE, PROJECT_DIFF_FEATURE } from './project-content-protocol';
import { QUESTIONS_FEATURE, STEER_FEATURE } from './interaction-protocol';
import { SESSION_SEARCH_FEATURE } from './search-protocol';
import { GIT_WORKTREE_FEATURE, GIT_OPERATIONS_FEATURE } from './git-protocol';
import { SESSION_FORK_FEATURE, FORK_OPERATIONS_FEATURE } from './fork-protocol';
import { GITHUB_FEATURE } from './github-protocol';
import { GITHUB_WRITE_FEATURE } from './github-write-protocol';
import { PREVIEW_FEATURE } from './preview-protocol';
import { SKILLS_FEATURE } from './skills-protocol';
import { ROLE_LIMITS } from './role-protocol';
import { MCP_LIMITS } from './mcp-protocol';
import {
  SESSION_CONTROL_FEATURE,
  ATTACHMENT_OPERATIONS_FEATURE,
  SESSION_CONTROL_LIMITS,
} from './session-control-protocol';
import { TASK_LIMITS } from './task-protocol';

const KiB = 1024,
  MiB = 1024 * KiB;
type HttpRoute =
  | { method: 'POST'; path: string }
  | { method: 'GET'; path: 'sessions'; session?: true };
type CommandContract = {
  http: HttpRoute;
  requestBytes: number;
  responseBytes: number;
  feature: string | undefined;
  // Delivery classification preserves error evidence; it never authorizes retries.
  delivery: 'ordinary' | 'action' | 'recovery';
};
/** Fixed public routes only. There is no arbitrary command endpoint or runtime registration. */
export const hostCommandContracts = {
  sessions: {
    http: { method: 'GET', path: 'sessions' },
    requestBytes: 0,
    responseBytes: SESSION_RESPONSE_LIMITS.listBytes,
    feature: undefined,
    delivery: 'ordinary',
  },
  'sessions-page': {
    http: { method: 'POST', path: 'sessions-page' },
    requestBytes: 16 * KiB,
    responseBytes: SESSION_PAGE_LIMITS.responseBytes,
    feature: SESSION_PAGE_FEATURE,
    delivery: 'ordinary',
  },
  'agent-options': {
    http: { method: 'POST', path: 'agent-options' },
    requestBytes: 4 * KiB,
    responseBytes: 16 * MiB,
    feature: undefined,
    delivery: 'ordinary',
  },
  'agent-usage': {
    http: { method: 'POST', path: 'agent-usage' },
    requestBytes: 4 * KiB,
    responseBytes: 256 * KiB,
    feature: AGENT_CONTROLS_FEATURE,
    delivery: 'ordinary',
  },
  'run-preferences': {
    http: { method: 'POST', path: 'run-preferences' },
    requestBytes: 4 * KiB,
    responseBytes: 16 * KiB,
    feature: AGENT_CONTROLS_FEATURE,
    delivery: 'ordinary',
  },
  session: {
    http: { method: 'GET', path: 'sessions', session: true },
    requestBytes: 0,
    responseBytes: SESSION_RESPONSE_LIMITS.readBytes,
    feature: undefined,
    delivery: 'ordinary',
  },
  'roles-read': {
    http: { method: 'POST', path: 'roles/read' },
    requestBytes: ROLE_LIMITS.requestBytes,
    responseBytes: ROLE_LIMITS.responseBytes,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'mcp-read': {
    http: { method: 'POST', path: 'mcp/read' },
    requestBytes: MCP_LIMITS.requestBytes,
    responseBytes: MCP_LIMITS.responseBytes,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'session-control': {
    http: { method: 'POST', path: 'session-control' },
    requestBytes: SESSION_CONTROL_LIMITS.requestBytes,
    responseBytes: SESSION_CONTROL_LIMITS.responseBytes,
    feature: SESSION_CONTROL_FEATURE,
    delivery: 'ordinary',
  },
  'session-operations': {
    http: { method: 'POST', path: 'session-operations' },
    requestBytes: SESSION_CONTROL_LIMITS.requestBytes,
    responseBytes: SESSION_CONTROL_LIMITS.responseBytes,
    feature: SESSION_CONTROL_FEATURE,
    delivery: 'recovery',
  },
  'tasks-read': {
    http: { method: 'POST', path: 'tasks-read' },
    requestBytes: TASK_LIMITS.requestBytes,
    responseBytes: TASK_LIMITS.responseBytes,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'tasks-action': {
    http: { method: 'POST', path: 'tasks-action' },
    requestBytes: TASK_LIMITS.requestBytes,
    responseBytes: TASK_LIMITS.responseBytes,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'roles-action': {
    http: { method: 'POST', path: 'roles/action' },
    requestBytes: ROLE_LIMITS.requestBytes,
    responseBytes: ROLE_LIMITS.responseBytes,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'skills-read': {
    http: { method: 'POST', path: 'skills/read' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: SKILLS_FEATURE,
    delivery: 'ordinary',
  },
  'preview-read': {
    http: { method: 'POST', path: 'preview/read' },
    requestBytes: 16 * KiB,
    responseBytes: 6 * MiB,
    feature: PREVIEW_FEATURE,
    delivery: 'ordinary',
  },
  'preview-action': {
    http: { method: 'POST', path: 'preview/action' },
    requestBytes: 16 * KiB,
    responseBytes: 6 * MiB,
    feature: PREVIEW_FEATURE,
    delivery: 'action',
  },
  'preview-inspect': {
    http: { method: 'POST', path: 'preview/inspect' },
    requestBytes: 32 * KiB,
    responseBytes: 6 * MiB,
    feature: RETIRED_RECORDS_FEATURE,
    delivery: 'recovery',
  },
  'preview-close': {
    http: { method: 'POST', path: 'preview/close' },
    requestBytes: 16 * KiB,
    responseBytes: 6 * MiB,
    feature: PREVIEW_FEATURE,
    delivery: 'recovery',
  },
  'github-write-read': {
    http: { method: 'POST', path: 'github-write/read' },
    requestBytes: 3 * MiB,
    responseBytes: 3 * MiB,
    feature: GITHUB_WRITE_FEATURE,
    delivery: 'ordinary',
  },
  'github-write-action': {
    http: { method: 'POST', path: 'github-write/action' },
    requestBytes: 256 * KiB,
    responseBytes: 16 * KiB,
    feature: GITHUB_WRITE_FEATURE,
    delivery: 'action',
  },
  'github-write-inspect': {
    http: { method: 'POST', path: 'github-write/inspect' },
    requestBytes: 256 * KiB,
    responseBytes: 16 * KiB,
    feature: GITHUB_WRITE_FEATURE,
    delivery: 'recovery',
  },
  'github-write-abandon': {
    http: { method: 'POST', path: 'github-write/abandon' },
    requestBytes: 256 * KiB,
    responseBytes: 16 * KiB,
    feature: GITHUB_WRITE_FEATURE,
    delivery: 'recovery',
  },
  'github-read': {
    http: { method: 'POST', path: 'github/read' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GITHUB_FEATURE,
    delivery: 'ordinary',
  },
  'github-action': {
    http: { method: 'POST', path: 'github/action' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GITHUB_FEATURE,
    delivery: 'action',
  },
  'github-abandon': {
    http: { method: 'POST', path: 'github/abandon' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GITHUB_FEATURE,
    delivery: 'action',
  },
  'send-turn': {
    http: { method: 'POST', path: 'send-turn' },
    requestBytes: SESSION_INTENT_LIMITS.requestBytes,
    responseBytes: SESSION_INTENT_LIMITS.responseBytes,
    feature: SESSION_INTENTS_FEATURE,
    delivery: 'ordinary',
  },
  'respond-permission': {
    http: { method: 'POST', path: 'respond-permission' },
    requestBytes: SESSION_INTENT_LIMITS.requestBytes,
    responseBytes: SESSION_INTENT_LIMITS.responseBytes,
    feature: SESSION_INTENTS_FEATURE,
    delivery: 'ordinary',
  },
  mutate: {
    http: { method: 'POST', path: 'mutations' },
    requestBytes: 34 * MiB,
    responseBytes: SESSION_RESPONSE_LIMITS.receiptBytes,
    feature: undefined,
    delivery: 'ordinary',
  },
  'session-action': {
    http: { method: 'POST', path: 'session-actions' },
    requestBytes: 4 * KiB,
    responseBytes: SESSION_RESPONSE_LIMITS.receiptBytes,
    feature: undefined,
    delivery: 'ordinary',
  },
  'file-content': {
    http: { method: 'POST', path: 'file-content' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: FILE_CONTENT_FEATURE,
    delivery: 'ordinary',
  },
  'attachment-action': {
    http: { method: 'POST', path: 'attachment-actions' },
    requestBytes: 12 * MiB,
    responseBytes: 64 * KiB,
    feature: ATTACHMENTS_FEATURE,
    delivery: 'ordinary',
  },
  'read-attachment': {
    http: { method: 'POST', path: 'attachments/read' },
    requestBytes: 16 * KiB,
    responseBytes: 12 * MiB,
    feature: ATTACHMENTS_FEATURE,
    delivery: 'ordinary',
  },
  'read-project-tree': {
    http: { method: 'POST', path: 'project-tree' },
    requestBytes: 16 * KiB,
    responseBytes: 16 * MiB,
    feature: PROJECT_TREE_FEATURE,
    delivery: 'ordinary',
  },
  'read-turn-diff': {
    http: { method: 'POST', path: 'turn-diff' },
    requestBytes: 16 * KiB,
    responseBytes: 48 * MiB,
    feature: PROJECT_DIFF_FEATURE,
    delivery: 'ordinary',
  },
  'read-diff-file': {
    http: { method: 'POST', path: 'diff-file' },
    requestBytes: 16 * KiB,
    responseBytes: 16 * MiB,
    feature: PROJECT_DIFF_FEATURE,
    delivery: 'ordinary',
  },
  'answer-question': {
    http: { method: 'POST', path: 'question-answers' },
    requestBytes: 2 * MiB,
    responseBytes: 64 * KiB,
    feature: QUESTIONS_FEATURE,
    delivery: 'ordinary',
  },
  steer: {
    http: { method: 'POST', path: 'steer' },
    requestBytes: 128 * KiB,
    responseBytes: 64 * KiB,
    feature: STEER_FEATURE,
    delivery: 'ordinary',
  },
  'search-sessions': {
    http: { method: 'POST', path: 'session-search' },
    requestBytes: 8 * KiB,
    responseBytes: 2 * MiB,
    feature: SESSION_SEARCH_FEATURE,
    delivery: 'ordinary',
  },
  'git-state': {
    http: { method: 'POST', path: 'git/state' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GIT_WORKTREE_FEATURE,
    delivery: 'ordinary',
  },
  'git-action': {
    http: { method: 'POST', path: 'git/action' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GIT_WORKTREE_FEATURE,
    delivery: 'action',
  },
  'git-operations': {
    http: { method: 'POST', path: 'git/operations' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: GIT_OPERATIONS_FEATURE,
    delivery: 'recovery',
  },
  'fork-options': {
    http: { method: 'POST', path: 'fork/options' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: SESSION_FORK_FEATURE,
    delivery: 'ordinary',
  },
  'fork-operations': {
    http: { method: 'POST', path: 'fork/operations' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: FORK_OPERATIONS_FEATURE,
    delivery: 'recovery',
  },
  'fork-action': {
    http: { method: 'POST', path: 'fork/action' },
    requestBytes: 16 * KiB,
    responseBytes: 2 * MiB,
    feature: SESSION_FORK_FEATURE,
    delivery: 'action',
  },
  cancel: {
    http: { method: 'POST', path: 'cancel' },
    requestBytes: 4 * KiB,
    responseBytes: SESSION_RESPONSE_LIMITS.receiptBytes,
    feature: undefined,
    delivery: 'ordinary',
  },
} as const satisfies Record<HostCommandMethod, CommandContract>;

/** Resolve only exact registered replica suffixes. Extra segments and wrong verbs are rejected. */
export function matchHostCommandRoute(
  verb: string | undefined,
  segments: readonly string[],
): HostCommandMethod | undefined {
  for (const method of Object.keys(hostCommandContracts) as HostCommandMethod[]) {
    const route: HttpRoute = hostCommandContracts[method].http;
    if (verb !== route.method) continue;
    if (route.method === 'GET') {
      if (segments[0] === 'sessions' && segments.length === (route.session ? 2 : 1)) return method;
    } else if (segments.join('/') === route.path) return method;
  }
}
export function hostCommandHttpRequest(command: HostCommand) {
  const route: HttpRoute = hostCommandContracts[command.method].http;
  if (command.method === 'session')
    return {
      path:
        'sessions/' +
        encodeURIComponent(command.params.sessionId) +
        (command.params.version === undefined
          ? ''
          : '?version=' + encodeURIComponent(command.params.version)),
      body: undefined,
    };
  return { path: route.path, body: route.method === 'GET' ? undefined : command.params };
}

/** Current feature gates, including the few request-dependent capabilities. No account authority is inferred here. */
export function hostCommandFeatures(command: HostCommand): readonly string[] {
  const feature = hostCommandContracts[command.method].feature;
  const result: string[] = feature ? [feature] : [];
  if (command.method === 'session-action') result.push('session-actions');
  if (command.method === 'mutate' && command.params.kind === 'turn')
    result.push(RETIRED_RECORDS_FEATURE);
  if (command.method === 'agent-options' && command.params.modelId)
    result.push(AGENT_MODEL_OPTIONS_FEATURE);
  if (
    command.method === 'run-preferences' &&
    ['read-defaults', 'save-defaults'].includes(command.params.action)
  )
    result.push(AGENT_RUN_DEFAULTS_FEATURE);
  const recoveryFeature = hostCommandRecoveryFeature(command);
  if (recoveryFeature) result.push(recoveryFeature);
  return result;
}
/** Recovery must support the exact original command, not just the generic envelope. */
export function hostCommandRecoveryFeature(command: HostCommand): string | undefined {
  if (command.method !== 'session-operations') return;
  if (command.params.request.kind === 'attachment') return ATTACHMENT_OPERATIONS_FEATURE;
  if (
    command.params.request.kind === 'send-turn' ||
    command.params.request.kind === 'respond-permission'
  )
    return SESSION_INTENTS_FEATURE;
}
type RetiredHostCommand = Extract<
  HostCommand,
  {
    method: 'preview-read' | 'preview-action' | 'preview-close';
  }
>;
export function assertHostCommandActive(
  command: HostCommand,
): asserts command is Exclude<HostCommand, RetiredHostCommand> {
  if (
    command.method === 'preview-read' ||
    command.method === 'preview-action' ||
    command.method === 'preview-close' ||
    ((command.method === 'roles-action' || command.method === 'tasks-action') &&
      command.params.action !== 'inspect')
  )
    throw new AppError(410, RETIRED_SESSION_FEATURE);
}
