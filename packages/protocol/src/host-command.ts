import { sendTurnSchema, respondPermissionSchema } from './session-intent-protocol';
import { z } from 'zod';
import { agentUsageRequestSchema, runPreferencesRequestSchema } from './agent-controls';
import { AppError, assert, id, mutationSchema, sessionActionSchema } from './protocol';
import { agentOptionsRequestSchema } from './protocol';
import { sessionPageRequestSchema } from './session-page';
import { sessionBase64Schema, sessionCancelSchema } from './session-responses';
import { projectFileReadSchema } from './content-protocol';
import { attachmentActionSchema, attachmentReadSchema } from './attachment-protocol';
import {
  projectTreeReadSchema,
  projectTurnDiffReadSchema,
  projectDiffFileReadSchema,
} from './project-content-protocol';
import { questionAnswerSchema, steerRequestSchema } from './interaction-protocol';
import { sessionSearchRequestSchema } from './search-protocol';
import { gitStateReadSchema, gitActionSchema, gitOperationSchema } from './git-protocol';
import { forkOptionsReadSchema, sessionForkSchema, forkOperationSchema } from './fork-protocol';
import { githubReadSchema, githubActionSchema } from './github-protocol';
import {
  githubWriteReadSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
} from './github-write-protocol';
import { mcpReadSchema } from './mcp-protocol';
import { sessionControlActionSchema, sessionOperationSchema } from './session-control-protocol';
import { taskReadSchema, taskActionSchema } from './task-protocol';
import { skillsReadSchema } from './skills-protocol';
import { rolesReadSchema, rolesActionRequestSchema } from './role-protocol';
import {
  previewReadSchema,
  previewActionSchema,
  previewInspectSchema,
  previewCloseSchema,
} from './preview-protocol';

// This is the existing execution surface, not a list of safe-to-retry reads.
// agent-options opens ACP and persists capabilities. Metadata and recovery operations
// can have unknown delivery outcomes and retain their original operation identity.
export const hostCommandSchemas = {
  sessions: z.object({}).strict(),
  'sessions-page': sessionPageRequestSchema,
  'agent-options': agentOptionsRequestSchema,
  'agent-usage': agentUsageRequestSchema,
  'run-preferences': runPreferencesRequestSchema,
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
  'send-turn': sendTurnSchema,
  'respond-permission': respondPermissionSchema,
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
  'git-operations': gitOperationSchema,
  'fork-options': forkOptionsReadSchema,
  'fork-action': sessionForkSchema,
  'fork-operations': forkOperationSchema,
  cancel: sessionCancelSchema,
};
export type HostCommandMethod = keyof typeof hostCommandSchemas;
export const HOST_COMMAND_METHODS = Object.freeze(Object.keys(hostCommandSchemas)) as readonly [
  HostCommandMethod,
  ...HostCommandMethod[],
];

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
