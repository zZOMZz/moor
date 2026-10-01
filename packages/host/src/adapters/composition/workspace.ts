import { setImmediate } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { agentProgramFingerprint } from '../acp/program';
import type { HostEnvironment } from '../../features/runtime/environment';
import { createGitHubClient } from '../github/read-client';
import { createGitHubWriteClient } from '../github/write-client';
import { readProjectFileBytes } from '../files/read';
import {
  inspectProjectWorktree,
  prepareProjectWorktree,
  readProjectGit,
  removeProjectWorktree,
} from '../git/worktree';
import {
  commitProject,
  inspectCommitCandidate,
  inspectProjectCommit,
  inspectProjectPush,
  planProjectCommit,
  pushProject,
} from '../git/write';
import { discoverSkills } from '../files/skills';
import { captureProjectSnapshot, enumerateProjectFiles } from '../files/snapshot';
import { HostWorkspace } from '../../features/runtime/workspace';
import { projectSkillSources } from '../files/skills-sources';
const environment: HostEnvironment = {
  uuid: randomUUID,
  yieldWork: setImmediate,
  hash: (value) => createHash('sha256').update(value).digest('hex'),
  programFingerprint: agentProgramFingerprint,
  directory: (input) => {
    const path = realpathSync(input),
      stat = lstatSync(path, { bigint: true });
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  },
};
type Arguments = ConstructorParameters<typeof HostWorkspace>;
/** Node entrypoint: create platform implementations before invoking Host policy. */
export function createHostWorkspace(
  store: Arguments[0],
  driver: Arguments[1],
  catalogue: Arguments[2],
  changed: Arguments[3],
  fileReader: Arguments[5] = readProjectFileBytes,
  projectContent: Arguments[6] = { capture: captureProjectSnapshot, tree: enumerateProjectFiles },
  git: Arguments[7] = {
    readProjectGit,
    prepareProjectWorktree,
    inspectProjectWorktree,
    removeProjectWorktree,
  },
  github: Partial<Arguments[8]> = {},
  githubWrite: Partial<Arguments[9]> = {},
  skills: Partial<Arguments[10]> = {},
) {
  return new HostWorkspace(
    store,
    driver,
    catalogue,
    changed,
    environment,
    fileReader,
    projectContent,
    git,
    {
      client: createGitHubClient,
      now: Date.now,
      signal: () => AbortSignal.timeout(25000),
      ...github,
    },
    {
      config: github.config,
      client: createGitHubClient,
      writer: createGitHubWriteClient,
      git: {
        inspectCommitCandidate,
        planProjectCommit,
        commitProject,
        inspectProjectCommit,
        inspectProjectPush,
        pushProject,
        readProjectGit,
      },
      hash: environment.hash,
      now: Date.now,
      signal: () => AbortSignal.timeout(25000),
      overlaps: (a, b) => {
        const child = (root: string, path: string) => {
          const value = relative(root, path);
          return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith('../'));
        };
        return child(a, b) || child(b, a);
      },
      ...githubWrite,
    },
    {
      projectSources: projectSkillSources,
      discover: discoverSkills,
      hash: environment.hash,
      ...skills,
    },
  );
}
