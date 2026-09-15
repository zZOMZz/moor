import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createGitHubClient } from '@moor/host/integrations/github/client';
import { createGitHubWriteClient } from '@moor/host/integrations/github/write-client';
import type { GitHubProjectConfig } from '@moor/host/integrations/github/config';
import { createPreviewRenderer } from '@moor/host/integrations/preview/renderer';
import type { PreviewServiceBinding } from '@moor/host/integrations/preview/config';
import type { ExecutionLease } from '@moor/host/sessions/execution';
import type { SessionGithubOptions } from '@moor/host/sessions/github';
import type { SessionGithubWriteOptions } from '@moor/host/sessions/github-write';
import type { SessionPreviewOptions } from '@moor/host/sessions/preview';

const date = '2026-09-12T00:00:00Z';
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40);
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
type Comment = {
  id: number;
  body: string;
  user: { id: number; login: string };
  created_at: string;
  updated_at: string;
  issue_url: string;
};

/** Real provider clients and isolated Electron renderer; every external datum is synthetic. */
export async function createSecureIntegrationServices(
  project: string,
  localProjectId: string,
  options: { electronPath: string; workerPath: string },
) {
  project = realpathSync(project);
  if (!existsSync(join(project, '.git'))) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Synthetic',
      GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic',
      GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        {
          cwd: project,
          env,
          stdio: 'pipe',
        },
      );
    git('init', '-q', '-b', 'main');
    writeFileSync(
      join(project, 'SYNTHETIC_PRIVATE_INTEGRATION.txt'),
      'SYNTHETIC_PRIVATE_GIT_BASE\n',
    );
    git('add', '--', 'SYNTHETIC_PRIVATE_INTEGRATION.txt');
    git('commit', '-qm', 'synthetic integration baseline');
  }
  const repository = {
    id: 42,
    owner: { login: 'synthetic' },
    name: 'test',
    full_name: 'synthetic/test',
    default_branch: 'main',
    private: true,
    archived: false,
  };
  const issue = {
    id: 101,
    number: 1,
    title: 'SYNTHETIC_PRIVATE_ISSUE_TITLE',
    body: 'SYNTHETIC_PRIVATE_ISSUE_BODY',
    state: 'open',
    user: { login: 'synthetic', id: 9 },
    updated_at: date,
    labels: [],
  };
  const pull = {
    ...issue,
    id: 202,
    number: 2,
    title: 'SYNTHETIC_PRIVATE_PR_TITLE',
    body: 'SYNTHETIC_PRIVATE_PR_BODY',
    draft: false,
    merged: false,
    mergeable: true,
    head: { ref: 'topic', sha: headSha, repo: repository },
    base: { ref: 'main', sha: baseSha, repo: repository },
  };
  const branch = (name: 'main' | 'topic') => ({
    name,
    commit: { sha: name === 'main' ? baseSha : headSha },
    protected: false,
  });
  const comments: Comment[] = [];
  const githubCalls: { path: string; method: string; body?: unknown }[] = [];
  let closed = false;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    assert(!closed, 'Synthetic integration services are closed');
    const url = new URL(String(input)),
      method = init.method ?? 'GET',
      path = url.pathname;
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'manual');
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    githubCalls.push({ path: path + url.search, method, ...(body === undefined ? {} : { body }) });
    const base = '/repos/synthetic/test';
    if (method === 'GET') {
      if (path === '/user') return json({ id: 9, login: 'synthetic' });
      if (path === base) return json(repository);
      if (path === base + '/branches') return json([branch('main'), branch('topic')]);
      if (path === base + '/branches/main') return json(branch('main'));
      if (path === base + '/branches/topic') return json(branch('topic'));
      if (path === base + '/issues') return json([issue]);
      if (path === base + '/issues/1') return json(issue);
      if (path === base + '/pulls') return json([pull]);
      if (path === base + '/pulls/2') return json(pull);
      if (path === base + '/issues/1/comments') return json(comments);
      if (path === base + '/issues/2/comments' || path === base + '/pulls/2/comments')
        return json([]);
      if (path.startsWith(base + '/issues/comments/')) {
        const comment = comments.find((item) => String(item.id) === path.split('/').at(-1));
        return comment ? json(comment) : json({ message: 'Synthetic missing comment' }, 404);
      }
      if (path === base + '/pulls/2/files')
        return json([
          {
            sha: headSha,
            filename: 'SYNTHETIC_PRIVATE_FILE.txt',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-SYNTHETIC_PRIVATE_BEFORE\n+SYNTHETIC_PRIVATE_AFTER',
          },
        ]);
      if (path === base + '/commits/' + headSha + '/check-runs')
        return json({
          total_count: 1,
          check_runs: [
            {
              id: 301,
              head_sha: headSha,
              name: 'SYNTHETIC_PRIVATE_CHECK',
              status: 'completed',
              conclusion: 'success',
              started_at: date,
              completed_at: date,
            },
          ],
        });
      if (path === base + '/commits/' + headSha + '/status')
        return json({
          sha: headSha,
          repository,
          state: 'success',
          total_count: 1,
          statuses: [
            {
              id: 302,
              context: 'SYNTHETIC_PRIVATE_STATUS',
              state: 'success',
              description: 'SYNTHETIC_PRIVATE_STATUS_DESCRIPTION',
              updated_at: date,
            },
          ],
        });
    }
    if (method === 'POST' && path === base + '/issues/1/comments') {
      assert(body && typeof body === 'object' && !Array.isArray(body));
      assert.deepEqual(Object.keys(body), ['body']);
      const text = (body as { body: unknown }).body;
      assert.equal(typeof text, 'string');
      const comment: Comment = {
        id: 403 + comments.length,
        body: text as string,
        user: { id: 9, login: 'synthetic' },
        created_at: date,
        updated_at: date,
        issue_url: 'https://api.github.com' + base + '/issues/1',
      };
      comments.push(comment);
      return json(comment, 201);
    }
    return json({ message: 'Synthetic route is not available' }, 404);
  };
  const projectConfig: GitHubProjectConfig = {
    localProjectId,
    owner: 'synthetic',
    repo: 'test',
    token: 'SYNTHETIC_PRIVATE_GITHUB_TOKEN',
    credentialId: 'synthetic-credential',
    repositoryId: 42,
    version: hash('SYNTHETIC_PRIVATE_GITHUB_CONFIG'),
    writesEnabled: true,
  };
  const config = {
    getProject: (id: string) => {
      assert(!closed && id === localProjectId, 'Synthetic GitHub project is unavailable');
      return structuredClone(projectConfig);
    },
    isCurrent: (value: GitHubProjectConfig) => !closed && isDeepStrictEqual(value, projectConfig),
  };
  const client: typeof createGitHubClient = (value) => createGitHubClient({ ...value, fetch });
  const github: SessionGithubOptions = { config, client };
  const githubWrite: SessionGithubWriteOptions = {
    config,
    client,
    writer: (value) => createGitHubWriteClient({ ...value, fetch }),
  };
  const driver = createPreviewRenderer(options);
  const page = (next: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<title>${next ? 'SYNTHETIC_PRIVATE_PREVIEW_NEXT' : 'SYNTHETIC_PRIVATE_PREVIEW_PAGE'}</title>
<style>body{font:18px sans-serif;margin:32px;background:#f5f6fa;color:#172032}button,input{display:block;box-sizing:border-box;margin:20px 0;width:360px;height:48px;font:16px sans-serif}output{display:block;margin-top:20px}main{min-height:1600px}</style></head>
<body><main><h1>SYNTHETIC_PRIVATE_PREVIEW_HEADING</h1>
<button id="action">SYNTHETIC_PRIVATE_PREVIEW_BUTTON</button>
<input id="input" aria-label="SYNTHETIC_PRIVATE_PREVIEW_INPUT" placeholder="SYNTHETIC_PRIVATE_PREVIEW_INPUT">
<output id="result">SYNTHETIC_PRIVATE_PREVIEW_READY</output>
<a href="${next ? '/' : '/next'}">SYNTHETIC_PRIVATE_PREVIEW_NAVIGATE</a></main>
<script>document.getElementById('action').onclick=()=>{document.title='SYNTHETIC_PRIVATE_PREVIEW_CLICKED';document.getElementById('result').textContent='SYNTHETIC_PRIVATE_PREVIEW_CLICKED'};document.getElementById('input').oninput=(event)=>{document.title='SYNTHETIC_PRIVATE_PREVIEW_TYPED_'+event.target.value;document.getElementById('result').textContent='SYNTHETIC_PRIVATE_PREVIEW_TYPED_'+event.target.value}</script></body></html>`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !['/', '/next'].includes(request.url ?? '')) {
      response.writeHead(404).end('Synthetic route is not available');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(page(request.url === '/next'));
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      try {
        await driver.closeAll();
      } finally {
        await new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => reject(cause);
      server.once('error', error);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', error);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const binding: PreviewServiceBinding = {
      id: 'synthetic-preview',
      label: 'SYNTHETIC_PRIVATE_PREVIEW_SERVICE',
      startPath: '/',
      version: hash('SYNTHETIC_PRIVATE_PREVIEW_SERVICE'),
      origin: 'http://127.0.0.1:' + address.port,
      localProjectId,
      executionId: 'shared',
      rootIdentity: hash(project),
      projectRootIdentity: hash(project),
    };
    const matches = (lease: ExecutionLease) =>
      !closed &&
      lease.localProjectId === localProjectId &&
      lease.executionId === 'shared' &&
      realpathSync(lease.rootPath) === project &&
      realpathSync(lease.projectRoot) === project;
    const preview: SessionPreviewOptions = {
      driver,
      config: {
        getServices: (lease) => {
          if (!matches(lease)) return [];
          const { id, label, startPath, version } = binding;
          return [{ id, label, startPath, version }];
        },
        getService: (lease, id) =>
          matches(lease) && id === binding.id ? { ...binding } : undefined,
        isCurrent: (value, lease) => matches(lease) && isDeepStrictEqual(value, binding),
      },
    };
    return { github, githubWrite, preview, githubCalls, comments, close };
  } catch (error) {
    await close();
    throw error;
  }
}
