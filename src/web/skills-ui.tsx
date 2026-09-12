import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { BookOpen, X } from 'lucide-react';
import { paint } from './ui';
import { markdown } from './content';
import { skillsKey, type SkillsController } from './skills';

export type SkillsPanelProps = {
  controller?: SkillsController;
  reason?: string;
  canAdd: boolean;
  adding: boolean;
  onClose(): void;
  onRefresh(): void;
  onSelect(id: string): void;
  onAdd(): void;
};
const issueLabels = {
  unreadable: '不可读取',
  'invalid-text': '不是有效的 UTF-8 文本',
  'too-large': '超过 64 KiB 限制',
  limit: '达到扫描上限',
  'unsupported-entry': '不支持的文件或链接',
};
export function SkillsPanel(p: SkillsPanelProps) {
  const [query, setQuery] = useState('');
  const c = p.controller,
    catalog = c?.list,
    detail = c?.detail,
    busy = !!c?.busy || p.adding,
    blocked = busy || !!p.reason,
    needle = query.trim().toLocaleLowerCase(),
    counts = new Map<string, number>();
  for (const skill of catalog?.skills ?? [])
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog skills-panel">
          <div className="github-heading">
            <Dialog.Title>Skills</Dialog.Title>
            <button className="icon-button" onClick={p.onClose} aria-label="关闭 Skills">
              <X />
            </button>
          </div>
          <Dialog.Description>
            查看当前会话执行目录和本机登记的 Skills。发现文件不代表 Agent 已启用；Agent
            实际报告的命令可在“命令、计划与用量”中查看。
          </Dialog.Description>
          <p className="muted">
            引用会将完整说明加入可编辑草稿，兼容普通文本输入；不会安装或启用原生
            Skill，也不会自动读取附带脚本和资源。
          </p>
          {p.reason && <p role="status">{p.reason}</p>}
          {c?.error && <p role="alert">{c.error}</p>}
          <div className="skills-tools">
            <label>
              搜索 Skills
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="名称、说明或相对路径"
              />
            </label>
            <button disabled={blocked || !c} onClick={p.onRefresh}>
              {c?.busy ? '正在读取…' : '重新读取 Skills'}
            </button>
          </div>
          {catalog && (
            <>
              <div className="skills-sources">
                {catalog.sources.map((source) => (
                  <p key={source.id}>
                    {source.scope === 'project' ? '项目' : '主机全局'} · {source.label} ·{' '}
                    {source.status === 'available'
                      ? '可读取'
                      : source.status === 'missing'
                        ? '目录不存在'
                        : '目录不可读取'}
                  </p>
                ))}
              </div>
              {(catalog.truncated || catalog.issues.length > 0) && (
                <div className="skills-issues" role="status">
                  <p>
                    部分 Skills 未读取，列表不代表全部可用能力。
                    {catalog.truncated && '已达到扫描上限。'}
                  </p>
                  {catalog.issues.map((issue, index) => (
                    <p key={index}>
                      {catalog.sources.find((source) => source.id === issue.sourceId)?.label}
                      {issue.path ? ` · ${issue.path}` : ''} · {issueLabels[issue.reason]}
                    </p>
                  ))}
                </div>
              )}
              <div className="skills-columns">
                <div className="skills-list" aria-label="已发现的 Skills">
                  {catalog.skills
                    .filter((skill) =>
                      [skill.name, skill.description, skill.path]
                        .join('\n')
                        .toLocaleLowerCase()
                        .includes(needle),
                    )
                    .map((skill) => {
                      const source = catalog.sources.find(
                        (source) => source.id === skill.sourceId,
                      )!;
                      return (
                        <button
                          key={skill.id}
                          disabled={blocked}
                          aria-pressed={detail?.skill.id === skill.id}
                          onClick={() => p.onSelect(skill.id)}
                        >
                          <strong>
                            {skill.name}
                            {(counts.get(skill.name) ?? 0) > 1 ? ' · 同名' : ''}
                          </strong>
                          <span>
                            {source.scope === 'project' ? '项目' : '主机全局'} · {source.label}
                          </span>
                          <span>{skill.path}</span>
                          {skill.description && <span>{skill.description}</span>}
                          {skill.metadata === 'unparsed' && <small>元数据未解析，以原文为准</small>}
                        </button>
                      );
                    })}
                  {catalog.skills.length === 0 && <p>当前读取范围内未发现 Skill 文件。</p>}
                  {catalog.skills.length > 0 &&
                    !catalog.skills.some((skill) =>
                      [skill.name, skill.description, skill.path]
                        .join('\n')
                        .toLocaleLowerCase()
                        .includes(needle),
                    ) && <p>没有匹配的 Skill。</p>}
                </div>
                <section className="skills-detail" aria-label="Skill 完整说明">
                  {detail ? (
                    <>
                      <h3>{detail.skill.name}</h3>
                      <p>
                        {detail.source.label} · {detail.skill.path}
                      </p>
                      <p className="muted">
                        {detail.skill.byteLength} 字节 · 版本 {detail.skill.version}
                      </p>
                      <button disabled={blocked || !p.canAdd} onClick={p.onAdd}>
                        {p.adding ? '正在校验并保存…' : '将说明加入本次指令'}
                      </button>
                      <div dangerouslySetInnerHTML={{ __html: markdown(detail.text) }} />
                    </>
                  ) : (
                    <p>选择一个 Skill 查看完整说明。正文仅保留在当前面板，关闭后清除。</p>
                  )}
                </section>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showSkillsControl(props?: { disabled: boolean; onOpen(): void }) {
  paint(
    '#skills-control',
    props ? (
      <button
        className="icon-button"
        disabled={props.disabled}
        onClick={props.onOpen}
        aria-label="Skills"
        title="Skills"
      >
        <BookOpen />
      </button>
    ) : null,
  );
}
export function showSkillsPanel(props?: SkillsPanelProps) {
  paint(
    '#skills-view',
    props ? (
      <SkillsPanel
        key={props.controller ? skillsKey(props.controller.target) : 'unavailable'}
        {...props}
      />
    ) : null,
  );
}
