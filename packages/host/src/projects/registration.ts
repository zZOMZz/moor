import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { id, assert } from '@moor/protocol/protocol';
import { assertPrivatePathsOutsideProjects } from '@moor/e2ee/node/private-project-path';
import type { RuntimeStore } from '../persistence/store';

const identity = z
  .object({ workspaceId: id, userId: z.string().min(1).max(1000), machineId: id })
  .strict();
export const projectRegistrationSchema = z
  .object({
    identity,
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value)),
  })
  .strict();

/** Private desktop IPC only; folder selection cannot authorize a remote host. */
export function registerDesktopProject(
  runtime: RuntimeStore,
  input: unknown,
  privateRoots: string[],
) {
  const request = projectRegistrationSchema.parse(input);
  assert(
    request.identity.workspaceId === runtime.workspace.id &&
      request.identity.userId === runtime.workspace.userId &&
      request.identity.machineId === runtime.workspace.machineId,
    409,
    '本机执行身份已变化，请重新添加项目',
  );
  const root = realpathSync(request.path);
  assert(statSync(root).isDirectory(), 400, '项目必须是本机目录');
  accessSync(root, constants.R_OK | constants.X_OK);
  assertPrivatePathsOutsideProjects(privateRoots, [root]);
  assertPrivatePathsOutsideProjects([root], privateRoots);
  const projects = runtime.machine.scan({ prefix: ['localProject'] });
  assert(
    projects.length < 100 ||
      projects.some((row) => (row.value as { rootPath: string }).rootPath === root),
    413,
    '项目数量已达到限制',
  );
  const projectId = runtime.registerProject(root);
  return { identity: request.identity, projectId, path: root };
}
