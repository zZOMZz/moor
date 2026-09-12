import test from 'node:test';
import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import {
  CONTENT_LIMITS,
  FILE_CONTENT_FEATURE,
  projectFileResultSchema,
  type ProjectFileRead,
} from '../src/content-protocol';
import { putMeta } from '../src/model';
import { readProjectFileBytes, type ProjectFileReadOptions } from '../src/runtime/project-files';
import { RuntimeStore } from '../src/runtime/store';

function directory(t: { after(fn: () => void): void }) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-project-files-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'file.txt'), 'synthetic project bytes');
  return { temporary, root, file: join(root, 'src', 'file.txt') };
}
function fixture(
  t: { after(fn: () => void): void },
  reader: typeof readProjectFileBytes = readProjectFileBytes,
) {
  const paths = directory(t),
    store = new RuntimeStore(':memory:');
  Object.assign(store.workspace, {
    id: 'runtime-a',
    userId: 'local:synthetic',
    machineId: 'machine-a',
  });
  store.machine.set(['localProject', 'project-a'], {
    id: 'project-a',
    name: 'Synthetic project',
    rootPath: paths.root,
  });
  putMeta(store.meta, 'session-session-a', {
    id: 'session-a',
    userId: 'local:synthetic',
    machineId: 'machine-a',
    project: { kind: 'local', localProjectId: 'project-a' },
  });
  let dispatches = 0;
  const host = new HostWorkspace(
    store,
    {
      async open() {
        dispatches++;
        throw new Error('A file read must never open an Agent');
      },
    },
    () => {},
    () => {},
    reader,
  );
  t.after(() => {
    host.close();
    store.close();
  });
  const request: ProjectFileRead = {
    contentVersion: 1,
    workspaceId: 'runtime-a',
    localProjectId: 'project-a',
    sessionId: 'session-a',
    path: 'src/file.txt',
  };
  return { ...paths, store, host, request, dispatches: () => dispatches };
}
const status = (expected: number) => (error: any) => error.status === expected;

test('Moor GitHub credential and temporary files are reserved even when their parent is a registered project', async (t) => {
  const f = fixture(t);
  for (const path of [
    'github-v1.json',
    'src/github-v1.json',
    'src/github-v1.json.tmp-synthetic',
    'src/GITHUB-V1.JSON',
    'preview-v1.json',
    'src/preview-v1.json.tmp-synthetic',
    'skills-v1.json',
    'src/SKILLS-v1.JSON.tmp-synthetic',
    'src/PREVIEW-V1.JSON',
  ]) {
    writeFileSync(join(f.root, path), '{"token":"synthetic-private-github-token"}');
    await strict.rejects(f.host.readProjectFile({ ...f.request, path }), status(403));
  }
  writeFileSync(join(f.root, 'src/github-v1.json.example'), '{"token":"replace-me"}');
  strict.equal(
    (await f.host.readProjectFile({ ...f.request, path: 'src/github-v1.json.example' })).status,
    'content',
  );
  strict.equal(f.dispatches(), 0);
});

test('host confirms scoped bytes without invoking an Agent or persisting content', async (t) => {
  const f = fixture(t),
    beforeMeta = f.store.meta.exportJson(),
    beforeMachine = f.store.machine.exportJson(),
    beforeRows = f.store.journal.db.prepare('SELECT * FROM runtime_state').all();
  strict.ok(f.host.workspace.features?.includes(FILE_CONTENT_FEATURE));
  const result = projectFileResultSchema.parse(
    await f.host.readProjectFile(f.request, 'project-a'),
  );
  strict.equal(result.status, 'content');
  strict.equal(result.confirmed, true);
  strict.equal(result.workspaceId, f.request.workspaceId);
  strict.equal(result.localProjectId, f.request.localProjectId);
  strict.equal(result.sessionId, f.request.sessionId);
  strict.equal(result.path, f.request.path);
  strict.deepEqual(result.content, {
    version: 'sha256:' + createHash('sha256').update('synthetic project bytes').digest('hex'),
    byteLength: 23,
    mediaType: 'text/plain',
  });
  strict.equal(
    result.status === 'content' && Buffer.from(result.data, 'base64').toString(),
    'synthetic project bytes',
  );
  strict.equal(f.dispatches(), 0);
  strict.deepEqual(f.store.meta.exportJson(), beforeMeta);
  strict.deepEqual(f.store.machine.exportJson(), beforeMachine);
  strict.deepEqual(f.store.journal.db.prepare('SELECT * FROM runtime_state').all(), beforeRows);
  strict.deepEqual(f.store.journal.db.prepare('SELECT * FROM session').all(), []);
  strict.deepEqual(f.store.journal.db.prepare('SELECT * FROM agent_session').all(), []);
});

test('known versions are confirmed by a fresh host read, including same-mtime changes', async (t) => {
  let reads = 0;
  const f = fixture(t, async (...args) => {
    reads++;
    return readProjectFileBytes(...args);
  });
  const first = await f.host.readProjectFile(f.request),
    known = { ...f.request, knownVersion: first.content.version },
    unchanged = await f.host.readProjectFile(known),
    timestamp = statSync(f.file);
  strict.equal(unchanged.status, 'not-modified');
  strict.equal('data' in unchanged, false);
  writeFileSync(f.file, 'modified! project bytes');
  utimesSync(f.file, timestamp.atime, timestamp.mtime);
  const changed = await f.host.readProjectFile(known);
  strict.equal(changed.status, 'content');
  strict.notEqual(changed.content.version, first.content.version);
  strict.equal(reads, 3);
  rmSync(f.file);
  await strict.rejects(f.host.readProjectFile(known), status(404));
  strict.equal(reads, 4);
});

test('scope, removed projects and malformed paths are rejected before filesystem access', async (t) => {
  let reads = 0;
  const f = fixture(t, async (...args) => {
    reads++;
    return readProjectFileBytes(...args);
  });
  for (const request of [
    { ...f.request, workspaceId: 'other-runtime' },
    { ...f.request, localProjectId: 'other-project' },
    { ...f.request, sessionId: 'other-session' },
  ])
    await strict.rejects(f.host.readProjectFile(request));
  await strict.rejects(f.host.readProjectFile(f.request, 'other-route-project'));
  for (const path of [
    '/file',
    '../file',
    'src/../file',
    'src//file',
    'src\\file',
    'src/file\n',
    'src/.',
    'src/C:file',
  ])
    await strict.rejects(f.host.readProjectFile({ ...f.request, path }));
  putMeta(f.store.meta, 'session-session-a', { userId: 'other-account' });
  await strict.rejects(f.host.readProjectFile(f.request), status(404));
  putMeta(f.store.meta, 'session-session-a', {
    userId: 'local:synthetic',
    machineId: 'other-machine',
  });
  await strict.rejects(f.host.readProjectFile(f.request), status(404));
  putMeta(f.store.meta, 'session-session-a', { machineId: 'machine-a' });
  f.store.machine.set(['localProject', 'project-a'], { id: 'removed-project' });
  await strict.rejects(f.host.readProjectFile(f.request), status(404));
  strict.equal(reads, 0);
});

test('host rechecks project root, session ownership and connection after the read', async (t) => {
  for (const change of ['root', 'session', 'project', 'workspace', 'closed'] as const) {
    await t.test(change, async (t) => {
      let f: ReturnType<typeof fixture>;
      f = fixture(t, async (...args) => {
        const result = await readProjectFileBytes(...args);
        if (change === 'root') {
          const project = { id: 'project-a', name: 'Replacement', rootPath: f.temporary };
          f.store.machine.set(['localProject', 'project-a'], project);
          f.host.workspace.projects = [project];
        } else if (change === 'session') {
          putMeta(f.store.meta, 'session-session-a', {
            project: { kind: 'local', localProjectId: 'other-project' },
          });
        } else if (change === 'project') f.host.workspace.projects = [];
        else if (change === 'workspace') f.host.workspace.id = 'other-runtime';
        else f.host.closed = true;
        return result;
      });
      await strict.rejects(f.host.readProjectFile(f.request));
    });
  }
});

test('file bytes preserve binary and invalid UTF-8 without trusting extensions', async (t) => {
  const f = fixture(t);
  for (const [bytes, mediaType] of [
    [Buffer.from('中文 synthetic <script>alert(1)</script>'), 'text/plain'],
    [Buffer.from([0xff, 0x61]), 'application/octet-stream'],
    [Buffer.from([0x61, 0x00, 0x62]), 'application/octet-stream'],
    [Buffer.alloc(0), 'text/plain'],
  ] as const) {
    writeFileSync(f.file, bytes);
    const result = await f.host.readProjectFile(f.request);
    strict.equal(result.content.mediaType, mediaType);
    strict.equal(result.content.byteLength, bytes.length);
    strict.equal(result.status, 'content');
    if (result.status === 'content') strict.deepEqual(Buffer.from(result.data, 'base64'), bytes);
  }
});

test('reader accepts exactly 1 MiB and rejects oversized files and growth during read', async (t) => {
  const f = directory(t);
  writeFileSync(f.file, Buffer.alloc(CONTENT_LIMITS.fileBytes, 65));
  strict.equal(
    (await readProjectFileBytes(f.root, 'src/file.txt')).bytes.length,
    CONTENT_LIMITS.fileBytes,
  );
  writeFileSync(f.file, Buffer.alloc(CONTENT_LIMITS.fileBytes + 1, 65));
  await strict.rejects(readProjectFileBytes(f.root, 'src/file.txt'), status(413));
  writeFileSync(f.file, 'small');
  await strict.rejects(
    readProjectFileBytes(f.root, 'src/file.txt', {
      checkpoint(stage) {
        if (stage === 'before-read')
          writeFileSync(f.file, Buffer.alloc(CONTENT_LIMITS.fileBytes + 1, 65));
      },
    }),
    status(413),
  );
});

test('reader rejects symlinks in the root, ancestors and leaf, including links inside the project', async (t) => {
  for (const location of ['root', 'ancestor', 'leaf'] as const) {
    await t.test(location, async (t) => {
      const f = directory(t),
        target =
          location === 'root' ? f.root : location === 'ancestor' ? join(f.root, 'src') : f.file;
      renameSync(target, target + '-real');
      symlinkSync(target + '-real', target);
      await strict.rejects(readProjectFileBytes(f.root, 'src/file.txt'), status(403));
    });
  }
});

test('reader rejects directory and leaf swaps at deterministic filesystem checkpoints', async (t) => {
  const stages: NonNullable<ProjectFileReadOptions['checkpoint']> extends (
    stage: infer S,
  ) => unknown
    ? S[]
    : never = ['directories-checked', 'opened', 'before-read', 'after-read'];
  for (const stage of stages) {
    for (const location of ['root', 'ancestor', 'leaf'] as const) {
      await t.test(stage + '/' + location, async (t) => {
        const f = directory(t);
        await strict.rejects(
          readProjectFileBytes(f.root, 'src/file.txt', {
            checkpoint(current) {
              if (current !== stage) return;
              const target =
                location === 'root'
                  ? f.root
                  : location === 'ancestor'
                    ? join(f.root, 'src')
                    : f.file;
              renameSync(target, target + '-original');
              if (location === 'leaf') writeFileSync(target, 'replacement file');
              else {
                const newParent = location === 'root' ? join(target, 'src') : target;
                mkdirSync(newParent, { recursive: true });
                writeFileSync(join(newParent, 'file.txt'), 'replacement file');
              }
            },
          }),
          status(409),
        );
      });
    }
  }
});

test('reader rejects symlink and FIFO leaf replacements without waiting for a writer', async (t) => {
  for (const replacement of ['symlink', 'fifo'] as const) {
    await t.test(replacement, async (t) => {
      const f = directory(t);
      await strict.rejects(
        readProjectFileBytes(f.root, 'src/file.txt', {
          checkpoint(stage) {
            if (stage !== 'directories-checked') return;
            renameSync(f.file, f.file + '-original');
            if (replacement === 'symlink') symlinkSync(f.file + '-original', f.file);
            else execFileSync('mkfifo', [f.file]);
          },
        }),
        status(replacement === 'symlink' ? 403 : 409),
      );
    });
  }
});

test('reader rejects ancestors changed to symlinks before opening or returning content', async (t) => {
  for (const stage of ['directories-checked', 'after-read'] as const) {
    for (const location of ['root', 'ancestor'] as const) {
      await t.test(stage + '/' + location, async (t) => {
        const f = directory(t);
        await strict.rejects(
          readProjectFileBytes(f.root, 'src/file.txt', {
            checkpoint(current) {
              if (current !== stage) return;
              const target = location === 'root' ? f.root : join(f.root, 'src');
              renameSync(target, target + '-original');
              symlinkSync(target + '-original', target);
            },
          }),
          status(409),
        );
      });
    }
  }
});

test('an ancestor swapped toward a sibling with the same project prefix never returns its bytes', async (t) => {
  const f = directory(t),
    sibling = join(f.temporary, 'project-other');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'file.txt'), 'outside-project-synthetic-sentinel');
  await strict.rejects(
    readProjectFileBytes(f.root, 'src/file.txt', {
      checkpoint(stage) {
        if (stage !== 'directories-checked') return;
        renameSync(join(f.root, 'src'), join(f.root, 'src-original'));
        symlinkSync(sibling, join(f.root, 'src'));
      },
    }),
    status(409),
  );
});

test('reader rejects in-place mutation after bytes were read and nonregular files', async (t) => {
  const f = directory(t);
  await strict.rejects(
    readProjectFileBytes(f.root, 'src/file.txt', {
      checkpoint(stage) {
        if (stage === 'after-read') writeFileSync(f.file, 'changed project content');
      },
    }),
    status(409),
  );
  await strict.rejects(readProjectFileBytes(f.root, 'src'), status(403));
  rmSync(f.file);
  execFileSync('mkfifo', [f.file]);
  await strict.rejects(readProjectFileBytes(f.root, 'src/file.txt'), status(403));
});
