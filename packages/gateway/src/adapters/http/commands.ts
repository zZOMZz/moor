import { AppError } from '@moor/protocol/protocol';
import { RETIRED_SESSION_FEATURE } from '@moor/protocol/connection-authority';
import { hostCommandSchemas, type HostCommandMethod } from '@moor/protocol/host-command';
import { hostCommandContracts } from '@moor/protocol/host-command-contract';
import { forwardReplicaCommand, type ReplicaCommandContext } from '../../features/commands/forward';
/** Only fixed HTTP routes supply this input; no arbitrary RPC method/URL is accepted. */
export async function forwardHttpReplicaCommand(
  input: {
    method: HostCommandMethod;
    segments: readonly string[];
    query: URLSearchParams;
    body(limit: number): Promise<unknown>;
  },
  context: ReplicaCommandContext,
) {
  if (['preview-read', 'preview-action', 'preview-close'].includes(input.method))
    throw new AppError(410, RETIRED_SESSION_FEATURE);
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
    params = await input.body(hostCommandContracts[input.method].requestBytes);
    if (input.method === 'mutate') params = hostCommandSchemas.mutate.strict().parse(params);
  }
  return forwardReplicaCommand({ method: input.method, params }, context);
}
