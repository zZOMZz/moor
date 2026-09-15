import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import {
  ProjectContentController,
  type ProjectContentContext,
  type ProjectContentMethod,
} from './project-content-controller';
import { SecureProjectContentCache } from './secure-project-content-cache';
export type SecureProjectContentContext = ProjectContentContext<SecureCliTarget>;
export type SecureProjectContentMethod = ProjectContentMethod;

export class SecureProjectContentController extends ProjectContentController<SecureCliTarget> {
  constructor(options: {
    context(): SecureProjectContentContext;
    request(
      target: SecureCliTarget,
      method: SecureProjectContentMethod,
      params: unknown,
    ): Promise<unknown>;
    cache?: SecureProjectContentCache;
  }) {
    super({
      ...options,
      parseTarget(input) {
        const target = secureTargetSchema.parse(input);
        if (!target.product) throw Error('请先选择已确认的项目副本。');
        return target;
      },
      contentTarget: (target) => ({
        owner: target.owner,
        deviceId: target.hostDeviceId,
        catalogWorkspaceId: target.product!.catalogWorkspaceId,
        replicaId: target.product!.replicaId,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
      }),
      cache: options.cache ?? new SecureProjectContentCache(),
    });
  }
}
