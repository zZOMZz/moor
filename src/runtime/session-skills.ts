import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assert } from '../protocol';
import type { ContentScope } from '../content-protocol';
import {
  SKILLS_LIMITS,
  skillsReadSchema,
  validateSkillsRead,
  type SkillSource,
  type SkillsRead,
  type SkillsReadResult,
} from '../skills-protocol';
import type { ExecutionLease } from './session-execution';
import type { SkillsConfig } from './skills-config';
import { discoverSkills } from './project-skills';

type Host = {
  ensureConnected(): void;
  executionLease(scope: ContentScope, project?: string, allowNew?: boolean): ExecutionLease;
};
export type SessionSkillsOptions = {
  config?: Pick<SkillsConfig, 'getSources' | 'createReadLease'>;
  discover?: typeof discoverSkills;
};
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 409, 'Skills 来源目录不可用');
  return [stat.dev.toString(), stat.ino.toString(), stat.mode.toString()];
}
function projectSources(lease: ExecutionLease) {
  const rootIdentity = directoryIdentity(resolve(lease.rootPath));
  const canonicalRoot = realpathSync(lease.rootPath);
  return (['agents', 'claude', 'codex'] as const).map((convention) => {
    const rootPath = join(canonicalRoot, '.' + convention, 'skills');
    let status: SkillSource['status'] = 'available';
    let identity: unknown;
    try {
      const parent = directoryIdentity(join(canonicalRoot, '.' + convention));
      identity = [parent, directoryIdentity(rootPath)];
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
      identity = status;
    }
    return {
      rootPath,
      source: {
        id: 'project-' + convention,
        label: '.' + convention + '/skills',
        scope: 'project' as const,
        convention,
        status,
        version: hash([lease, canonicalRoot, rootIdentity, rootPath, identity]),
      },
    };
  });
}

/** Read-only discovery never creates native Agent sessions or persists Skill bodies. */
export class SessionSkillsManager {
  private reading = 0;
  constructor(
    private host: Host,
    private options: SessionSkillsOptions = {},
  ) {}

  async read(input: SkillsRead, project?: string): Promise<SkillsReadResult> {
    this.host.ensureConnected();
    assert(this.reading < SKILLS_LIMITS.concurrentReads, 429, 'Skills 正在读取，请稍后手动重试');
    this.reading++;
    try {
      return await this.readNow(input, project);
    } finally {
      this.reading--;
    }
  }
  private async readNow(input: SkillsRead, project?: string): Promise<SkillsReadResult> {
    const request = skillsReadSchema.parse(input);
    this.host.ensureConnected();
    const lease = this.host.executionLease(request, project, true);
    const projects = projectSources(lease);
    const globalLease = this.options.config?.createReadLease(lease);
    const globals = globalLease?.sources ?? [];
    const sources = [
      ...projects,
      ...globals.map((binding) => ({
        rootPath: binding.rootPath,
        source: {
          id: binding.id,
          label: binding.label,
          scope: 'global' as const,
          convention: 'registered' as const,
          version: binding.version,
          status: 'available' as const,
        },
      })),
    ];
    const catalogVersion = hash([lease, sources]);
    const current = () => {
      this.host.ensureConnected();
      assert(
        isDeepStrictEqual(this.host.executionLease(request, project, true), lease),
        409,
        'Skills 的会话执行范围已变化，请重新读取',
      );
      assert(
        isDeepStrictEqual(projectSources(lease), projects),
        409,
        '项目 Skills 来源已变化，请重新读取',
      );
      globalLease?.assertCurrent();
    };
    if (request.view === 'detail') {
      assert(
        request.catalogVersion === catalogVersion &&
          request.executionRevision === lease.executionRevision,
        409,
        'Skills 目录或执行范围已变化，请重新读取',
      );
      assert(
        sources.some(
          (item) => item.source.id === request.sourceId && item.source.status === 'available',
        ),
        404,
        'Skill 来源不可用',
      );
    }
    current();
    const discovered = await (this.options.discover ?? discoverSkills)(sources, {
      assertCurrent: current,
    });
    current();
    if (this.options.config)
      assert(
        isDeepStrictEqual(this.options.config.getSources(lease), globals),
        409,
        '全局 Skills 授权已变化，请重新读取',
      );
    current();
    const base = {
      skillsVersion: 1 as const,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      catalogVersion,
      executionRevision: lease.executionRevision,
      confirmed: true as const,
    };
    if (request.view === 'list')
      return validateSkillsRead(
        {
          ...base,
          view: 'list',
          sources: discovered.sources,
          skills: discovered.skills,
          issues: discovered.issues,
          truncated: discovered.truncated,
        },
        request,
      );
    const document = discovered.documents.get(request.skillId);
    assert(
      document && document.skill.sourceId === request.sourceId,
      404,
      'Skill 不在当前可读取目录中，请重新读取列表',
    );
    assert(document.skill.version === request.version, 409, 'Skill 正文已变化，请重新读取后再引用');
    const source = discovered.sources.find((item) => item.id === request.sourceId)!;
    return validateSkillsRead({ ...base, view: 'detail', source, ...document }, request);
  }
}
