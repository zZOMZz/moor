import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Search, X } from 'lucide-react';
import { paint } from './ui';
import type { SearchHit } from '../search-protocol';
import type { SearchSession, SessionSearchView } from './session-search';

export type SessionSearchPanelProps = {
  title: string;
  online: boolean;
  sessions: readonly SearchSession[];
  busy?: boolean;
  error?: string;
  result?: SessionSearchView;
  onSearch(query: string, scope: 'session' | 'project'): void;
  onOpen(hit: SearchHit): void;
  onClose(): void;
};
export function SessionSearchPanel(props: SessionSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'session' | 'project'>('session');
  const result = props.result;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog session-search-panel">
          <div className="project-panel-heading">
            <div>
              <Dialog.Title>正文搜索</Dialog.Title>
              <Dialog.Description>{props.title}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭正文搜索">
              <X />
            </Dialog.Close>
          </div>
          <p className="project-source">
            {props.online
              ? '搜索执行电脑上的消息、工具输出和已保存 diff。'
              : '离线搜索仅覆盖本机缓存的会话和已读取的历史 diff。'}
            侧栏搜索用于标题、项目和电脑名称。
          </p>
          <form
            className="session-search-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.busy && query.trim()) props.onSearch(query, scope);
            }}
          >
            <label>
              搜索内容
              <input
                type="search"
                aria-label="搜索正文"
                value={query}
                maxLength={500}
                required
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              搜索范围
              <select
                aria-label="正文搜索范围"
                value={scope}
                onChange={(event) => setScope(event.target.value as 'session' | 'project')}
              >
                <option value="session">当前会话</option>
                <option value="project">当前电脑的项目</option>
              </select>
            </label>
            <button type="submit" disabled={props.busy || !query.trim()}>
              <Search />
              {props.busy ? '正在搜索…' : '搜索'}
            </button>
          </form>
          {props.error && (
            <p className="list-error" role="alert">
              {props.error}
            </p>
          )}
          {props.busy && <p role="status">正在搜索…</p>}
          {result && (
            <>
              <p className="project-source">
                {result.source === 'cache' ? '本机缓存' : '主机索引'} ·{' '}
                {result.scope === 'session' ? '当前会话' : '当前电脑的项目'} · “{result.query}” ·{' '}
                {result.hits.length} 条结果{result.more ? '，还有更多匹配，请缩小查询范围' : ''}
              </p>
              {result.coverage && (
                <p className="project-source">
                  已搜索 {result.coverage.cachedSessions}/{result.coverage.knownSessions}{' '}
                  个已知会话的缓存，读取 {result.coverage.cachedDiffFiles} 份历史文件缓存。
                </p>
              )}
              {result.partial && (
                <p className="project-partial">
                  部分内容尚未缓存、索引或超出本次搜索范围；未找到不表示内容不存在。
                </p>
              )}
              {!result.hits.length && <p className="empty">当前搜索范围内没有匹配结果。</p>}
              <ol className="session-search-results" aria-label="正文搜索结果">
                {result.hits.map((hit, index) => (
                  <li key={`${hit.sessionId}/${hit.turnId}/${hit.itemIndex}/${index}`}>
                    <button type="button" disabled={props.busy} onClick={() => props.onOpen(hit)}>
                      <strong>
                        {props.sessions.find((session) => session.id === hit.sessionId)?.title ??
                          hit.sessionId}
                      </strong>
                      <span>
                        {{ message: '消息', tool: '工具输出', diff: '文件变更' }[hit.kind]}
                        {hit.path ? ` · ${hit.path}` : ''}
                      </span>
                      <p>{hit.excerpt}</p>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showSessionSearchPanel(props?: SessionSearchPanelProps) {
  paint('#session-search-view', props ? <SessionSearchPanel {...props} /> : null);
}
export function showSessionSearchControl(props?: { enabled: boolean; onOpen(): void }) {
  paint(
    '#session-search-control',
    props ? (
      <button
        type="button"
        className="session-search-open"
        aria-label="正文搜索"
        disabled={!props.enabled}
        onClick={props.onOpen}
      >
        <Search />
        <span>正文搜索</span>
      </button>
    ) : null,
  );
}
