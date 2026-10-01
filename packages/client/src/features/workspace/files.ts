import {
  PROJECT_DIFF_FEATURE,
  PROJECT_TREE_FEATURE,
  projectDiffReferenceSchema,
} from '@moor/protocol/project-content-protocol';
import { SESSION_SEARCH_FEATURE, type SearchHit } from '@moor/protocol/search-protocol';
import { workspaceProjectTargetSchema } from '@moor/protocol/workspace-client-protocol';
import { WorkspacePersistence, type WorkspaceScope } from '../../operations/workspace/compose';
import { projectContentKey } from '../files/project-content';
import { ProjectContentController } from '../files/project-content-controller';
import { searchSessionContent, type SessionSearchView } from '../sessions/session-search';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import { same } from './model';
import type { WorkspaceSessionsService } from './sessions';
/** Capabilities consumed by files use cases; supplied only by the workspace composition root. */
export interface WorkspaceFilesPorts {
  store: Pick<WorkspacePersistence, 'contentCache' | 'cachedSession'>;
  context: Pick<
    WorkspaceContextService,
    'context' | 'value' | 'execute' | 'command' | 'emit' | 'contextRevision'
  >;
  drafts: Pick<WorkspaceDraftsService, 'flushDraft'>;
  sessions: Pick<WorkspaceSessionsService, 'openSession'>;
}
export class WorkspaceFilesService {
  constructor(readonly ports: WorkspaceFilesPorts) {}
  contentCache(scope: WorkspaceScope) {
    const cache = this.ports.store.contentCache(scope.source);
    return {
      read: async (target: Parameters<typeof cache.read>[0], key: string, current: () => void) => {
        current();
        if (!same({ ...scope.target, sessionId: target.sessionId }, target))
          throw Error('文件缓存目标已改变。');
        return cache.read(target, key, current);
      },
      writeBatch: cache.writeBatch.bind(cache),
    };
  }
  openSearch() {
    const context = this.ports.context.context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const target = context.scope.target;
    const contentTarget = (sessionId: string) => ({
      owner: target.owner,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      catalogWorkspaceId: target.catalogWorkspaceId,
      replicaId: target.replicaId,
      sessionId,
    });
    const sessions = this.ports.context.value.sessions.map((item) => ({
      id: item.id,
      title: item.title ?? '未命名会话',
    }));
    const online = !this.ports.context.value.offline;
    const files = this.contentCache(context.scope);
    let open = true,
      version = 0,
      result: SessionSearchView | undefined;
    const current = () => {
      context.current();
      if (!open || online === this.ports.context.value.offline)
        throw Error('搜索面板或连接已改变，请重新打开。');
    };
    return {
      close: () => {
        open = false;
        version++;
        result = undefined;
      },
      search: async (query: string, scope: 'session' | 'project') => {
        current();
        const serial = ++version;
        result = undefined;
        if (
          online &&
          !this.ports.context.value.project?.runtime.features?.includes(SESSION_SEARCH_FEATURE)
        )
          throw Error('此执行电脑尚未提供正文搜索能力。');
        const value = await searchSessionContent(
          contentTarget(context.sessionId!),
          { query, scope },
          online,
          sessions,
          {
            read: async (key) => {
              current();
              if (!key.startsWith('project-content-v1/')) throw Error('不支持的搜索缓存键。');
              const parts = JSON.parse(key.slice('project-content-v1/'.length)) as unknown;
              if (
                !Array.isArray(parts) ||
                typeof parts[4] !== 'string' ||
                !sessions.some((session) => session.id === parts[4]) ||
                !key.startsWith(projectContentKey(contentTarget(parts[4])).slice(0, -1) + ',')
              )
                throw Error('搜索文件缓存不属于当前项目。');
              return files.read({ ...target, sessionId: parts[4] }, key, current);
            },
            write: async () => {
              throw Error('正文搜索不修改文件缓存。');
            },
            readHistory: async (requested) => {
              current();
              if (!same(requested, contentTarget(requested.sessionId)))
                throw Error('搜索缓存范围不匹配。');
              const read = await this.ports.store.cachedSession(
                context.scope,
                requested.sessionId,
                current,
              );
              return read?.history;
            },
            request: (method, params) => {
              current();
              return this.ports.context.execute(
                { ...context, current },
                this.ports.context.command(context.scope, 'search-sessions', params),
              );
            },
          },
        );
        current();
        if (serial !== version) throw Error('搜索结果已被新的查询替代。');
        result = structuredClone(value);
        return value;
      },
      openHit: async (hit: SearchHit) => {
        current();
        if (!result?.hits.some((item) => same(item, hit))) throw Error('此结果不属于当前搜索。');
        await this.ports.drafts.flushDraft();
        current();
        try {
          await this.ports.sessions.openSession(hit.sessionId);
        } catch (error) {
          if (
            online ||
            !same(this.ports.context.value.scope, context.scope) ||
            this.ports.context.value.session?.meta.id !== hit.sessionId ||
            !this.ports.context.value.offline
          )
            throw error;
        }
        const selected = this.ports.context.context();
        selected.current();
        if (
          !same(selected.scope, context.scope) ||
          selected.sessionId !== hit.sessionId ||
          !this.ports.context.value.session?.history.some((turn) => turn.id === hit.turnId)
        )
          throw Error('原搜索位置已改变或尚未缓存，请重新搜索。');
        this.ports.context.value.searchFocus = structuredClone(hit);
        this.ports.context.emit();
      },
    };
  }
  async openProjectContent(
    changed: () => void = () => {},
    mode: 'tree' | 'changes' = 'tree',
    turnId?: string,
  ) {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context();
    if (!context.sessionId || !this.ports.context.value.session) throw Error('请先打开会话。');
    const sessionId = context.sessionId;
    const identity = { ...context.scope.target, sessionId };
    type Target = typeof identity;
    const parseTarget = (input: unknown): Target => {
      const target = workspaceProjectTargetSchema.parse(input);
      if (!target.sessionId) throw Error('文件缓存必须绑定原会话。');
      return { ...target, sessionId: target.sessionId };
    };
    const panel = new ProjectContentController<Target>({
      context: () => {
        try {
          context.current();
          return {
            target: identity,
            generation: this.ports.context.contextRevision,
            online: !this.ports.context.value.offline,
          };
        } catch {
          return { target: null, generation: this.ports.context.contextRevision, online: false };
        }
      },
      parseTarget: (input) => {
        const target = parseTarget(input);
        if (!same(target, identity)) throw Error('文件读取目标已改变。');
        return target;
      },
      contentTarget: ({
        owner,
        deviceId,
        catalogWorkspaceId,
        replicaId,
        workspaceId,
        localProjectId,
        sessionId,
      }) => ({
        owner,
        deviceId,
        catalogWorkspaceId,
        replicaId,
        workspaceId,
        localProjectId,
        sessionId,
      }),
      cache: this.contentCache(context.scope),
      request: async (target, method, params) => {
        context.current();
        if (!same(target, identity)) throw Error('文件读取目标已改变。');
        const feature =
          method === 'read-project-tree' || method === 'file-content'
            ? PROJECT_TREE_FEATURE
            : PROJECT_DIFF_FEATURE;
        if (!context.project.runtime.features?.includes(feature))
          throw Error('执行电脑尚未提供此文件读取能力。');
        return this.ports.context.execute(
          context,
          this.ports.context.command(context.scope, method, params),
        );
      },
    });
    const unsubscribe = panel.subscribe(changed);
    const turns = this.ports.context.value.session.history
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => {
        const reference = projectDiffReferenceSchema.safeParse(turn.fileDiff);
        return {
          id: turn.id,
          label: turn.id,
          ...(reference.success ? { reference: reference.data } : {}),
        };
      })
      .reverse();
    try {
      await panel.open(mode, turns, context.project.projectName + ' · 项目文件', turnId);
      context.current();
    } catch (error) {
      unsubscribe();
      panel.close();
      throw error;
    }
    return Object.assign(panel, {
      dispose: () => {
        unsubscribe();
        panel.close();
      },
    });
  }
}
