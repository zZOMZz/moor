import {
  hostCommandSchema,
  hostCommandSchemas,
  type HostCommand,
  type HostCommandMethod,
} from '@moor/protocol/host-command';
import {
  assertHostCommandActive,
  hostCommandContracts,
  hostCommandFeatures,
} from '@moor/protocol/host-command-contract';
import { validateHostResponse } from '@moor/protocol/host-response';
import { AppError, assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import { RETIRED_SESSION_FEATURE } from '@moor/protocol/connection-authority';
import { publicAgentFailure } from '@moor/protocol/agent-errors';

/** Constructed from an authenticated replica route, never from request fields.
 * Catalogue and execution workspace identities deliberately have different names. */
export type ReplicaCommandContext = {
  catalogWorkspaceId: string;
  runtimeWorkspaceId: string;
  localProjectId: string;
  workspace: RuntimeWorkspace;
  current(feature?: string): RuntimeWorkspace;
  dispatch(command: HostCommand): Promise<unknown>;
  dispatched(): void;
};
type ReplicaCommandInput = {
  method: HostCommandMethod;
  segments: readonly string[];
  query: URLSearchParams;
  body(limit: number): Promise<unknown>;
};

function agentCommand(command: HostCommand) {
  return command.method === 'agent-options' ||
    command.method === 'agent-usage' ||
    command.method === 'run-preferences'
    ? command
    : undefined;
}
function failedCommand(command: HostCommand, error: unknown): never {
  const recovery = hostCommandContracts[command.method].delivery === 'recovery';
  if (command.method === 'git-operations' || command.method === 'fork-operations')
    throw new AppError(502, '原操作核查结果未确认，请保留原请求后手动继续', false);
  if (agentCommand(command))
    throw new AppError(
      error instanceof AppError && [400, 403, 404, 409, 413, 429, 504].includes(error.status)
        ? error.status
        : 502,
      publicAgentFailure(error, 'Agent 能力暂时不可读取，请重新读取会话或检查执行电脑'),
    );
  if (
    recovery ||
    [
      'sessions',
      'sessions-page',
      'session',
      'send-turn',
      'respond-permission',
      'mutate',
      'session-action',
      'cancel',
      'session-control',
    ].includes(command.method)
  )
    throw new AppError(
      error instanceof AppError &&
        [400, 401, 403, 404, 409, 410, 413, 429, 504].includes(error.status)
        ? error.status
        : 502,
      error instanceof AppError && error.status === 410
        ? RETIRED_SESSION_FEATURE
        : ['sessions', 'sessions-page', 'session'].includes(command.method)
          ? '会话读取失败，请手动重新读取'
          : '会话操作未能确认，请手动查询原操作',
      !recovery && command.method !== 'cancel' && error instanceof AppError && error.rejected,
    );
  throw error;
}

/** The fixed public route chooses the command before this handler sees a body.
 * Every wait is followed by the original authenticated connection guard. */
export async function forwardReplicaCommand(
  input: ReplicaCommandInput,
  context: ReplicaCommandContext,
) {
  if (
    input.method === 'preview-read' ||
    input.method === 'preview-action' ||
    input.method === 'preview-close'
  )
    throw new AppError(410, RETIRED_SESSION_FEATURE);
  const contract = hostCommandContracts[input.method];
  let params: unknown;
  if (input.method === 'sessions') params = {};
  else if (input.method === 'session') {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(input.segments[1]!);
    } catch {
      throw new AppError(400, '会话编号无效');
    }
    params = { sessionId, version: input.query.get('version') ?? undefined };
  } else {
    params = await input.body(contract.requestBytes);
    // The existing public mutation endpoint rejects unknown fields instead of
    // stripping them; keep that compatibility boundary distinct from IPC parsing.
    if (input.method === 'mutate') params = hostCommandSchemas.mutate.strict().parse(params);
  }
  const command = hostCommandSchema.parse({
    method: input.method,
    workspaceId: context.runtimeWorkspaceId,
    localProjectId: context.localProjectId,
    params,
  });
  assertHostCommandActive(command);
  assert(context.workspace.id === context.runtimeWorkspaceId, 409, '执行工作区已变化');
  const outer = command.params as Record<string, unknown>;
  const scopes = [
    outer,
    ...(outer.request && typeof outer.request === 'object'
      ? [outer.request as Record<string, unknown>]
      : []),
  ];
  for (const scope of scopes)
    for (const [field, expected] of Object.entries({
      workspaceId: context.runtimeWorkspaceId,
      localProjectId: context.localProjectId,
      userId: context.workspace.userId,
      machineId: context.workspace.machineId,
    }))
      assert(!(field in scope) || scope[field] === expected, 400, '请求与执行项目范围不匹配');
  const features = hostCommandFeatures(command);
  const current = () => {
    let workspace = context.current();
    for (const feature of features) workspace = context.current(feature);
    const agent = agentCommand(command);
    if (agent && !agent.params.sessionId)
      assert(
        workspace.agents.some((value) => value.id === agent.params.agentId),
        409,
        'Agent 配置已变化，请重新读取',
      );
    return workspace;
  };
  const agent = agentCommand(command);
  if (agent && !agent.params.sessionId)
    assert(
      context.workspace.agents.some((value) => value.id === agent.params.agentId),
      404,
      'Agent 配置不可用',
    );
  current();
  let raw: unknown;
  try {
    if (contract.delivery === 'action') context.dispatched();
    raw = await context.dispatch(command);
  } catch (error) {
    current();
    failedCommand(command, error);
  }
  current();
  try {
    const result = await validateHostResponse(raw, {
      command,
      workspace: context.workspace,
      current,
    });
    if (command.method === 'agent-options') {
      const latest = current().agents.find((value) => value.id === command.params.agentId);
      const received = result as { cliType: string; agentType: string };
      assert(
        !latest || (latest.cliType === received.cliType && latest.agentType === received.agentType),
        502,
        'Agent 能力响应与请求版本不匹配',
      );
    }
    return result;
  } finally {
    // validateHostResponse hides untrusted diagnostics. Recheck separately so a
    // revoked login/mapping keeps its actual 401/409 and never becomes a cache hit.
    current();
  }
}
