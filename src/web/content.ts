export const esc = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function inline(text: string): string {
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let html = '',
    from = 0;
  for (const m of text.matchAll(tokens)) {
    html += esc(text.slice(from, m.index));
    from = m.index! + m[0].length;
    if (m[1] !== undefined) html += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined) html += `<strong>${esc(m[2])}</strong>`;
    else {
      let safe = false;
      try {
        const u = new URL(m[4]);
        safe = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
      } catch {}
      html += safe
        ? `<a href="${esc(m[4])}" target="_blank" rel="noopener noreferrer">${esc(m[3])}</a>`
        : esc(m[0]);
    }
  }
  return html + esc(text.slice(from));
}
export function codeBlock(text: string, label = '代码'): string {
  // Only display a bounded preview of large tool output; never run terminal escape sequences or HTML.
  const limit = 120_000;
  const value = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return `<div class="code-block"><div class="code-toolbar"><span>${esc(label)}</span><button type="button" data-copy>复制</button></div><pre><code>${esc(value.slice(0, limit))}</code></pre>${value.length > limit ? '<small>输出预览已截断；完整记录保留在执行电脑。</small>' : ''}</div>`;
}
// A deliberately small Markdown renderer. Raw HTML and images stay text; no HTML from the agent is trusted.
export function markdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let html = '',
    i = 0;
  const boundary = (s: string) => /^(?:\s*$|```|#{1,6} |[-*] |\d+\. |> )/.test(s);
  while (i < lines.length) {
    const line = lines[i++];
    if (!line.trim()) continue;
    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      html += codeBlock(code.join('\n'), fence[1].trim() || '代码');
    } else if (/^#{1,6} /.test(line)) {
      const m = line.match(/^(#{1,6}) (.*)$/)!;
      const n = Math.min(m[1].length + 1, 6);
      html += `<h${n}>${inline(m[2])}</h${n}>`;
    } else if (/^([-*] |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line),
        re = ordered ? /^\d+\. / : /^[-*] /;
      const items = [line.replace(re, '')];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>${items.map((s) => `<li>${inline(s)}</li>`).join('')}</${tag}>`;
    } else if (line.startsWith('> ')) html += `<blockquote>${inline(line.slice(2))}</blockquote>`;
    else {
      const p = [line];
      while (i < lines.length && !boundary(lines[i])) p.push(lines[i++]);
      html += `<p>${p.map(inline).join('<br>')}</p>`;
    }
  }
  return `<div class="markdown">${html}</div>`;
}
const detail = (id: string, label: string, body: string) =>
  `<details data-detail="${esc(id)}"><summary>${esc(label)}</summary>${body}</details>`;
const json = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
function toolContent(c: any, key: string): string {
  if (c.type === 'attachment') return renderAttachment(c.attachment);
  if (c.type === 'diff')
    return detail(
      key,
      `文件变更 · ${c.path}`,
      `<div class="diff-pair">${codeBlock(c.oldText ?? '', '修改前')}${codeBlock(c.newText ?? '', '修改后')}</div>`,
    );
  if (c.type === 'terminal_command')
    return codeBlock([c.command, ...(c.args ?? [])].join(' '), c.cwd ? `命令 · ${c.cwd}` : '命令');
  if (c.type === 'terminal_output') {
    const exit = c.exitStatus?.exitCode;
    const label = `${c.stream === 'stderr' ? '错误输出' : '终端输出'}${exit != null ? ` · 退出码 ${exit}` : ''}${c.truncated ? ' · 主机输出已截断' : ''}`;
    return detail(key, label, codeBlock(c.output ?? '', label));
  }
  if (c.type === 'terminal')
    return `<p class="subtle">终端 ${esc(c.terminalId)} · 等待输出快照</p>`;
  if (c.type === 'content') {
    const value = c.content;
    if (value?.type === 'text') return detail(key, '输出', codeBlock(value.text));
    if (value?.type === 'resource' && value.resource?.text)
      return detail(key, value.resource.uri ?? '资源', codeBlock(value.resource.text));
    return `<p class="subtle">${esc(value?.type ?? '附件')} · 当前以文本记录展示</p>`;
  }
  if (c.type === 'text') return detail(key, '输出', codeBlock(c.text));
  if (c.type === 'input' || c.type === 'output')
    return detail(key, c.type === 'input' ? '输入参数' : '输出', codeBlock(json(c[c.type])));
  return '';
}
export function renderItem(item: any, finished: boolean, key: string): string {
  if (item.type === 'attachment') return renderAttachment(item.attachment);
  if (item.type === 'text') return markdown(item.text ?? '');
  if (item.type === 'thought') return detail(key, '思考过程', markdown(item.text ?? ''));
  if (item.type === 'tool_call') {
    const p = item.permissionRequest;
    const labels: Record<string, string> = {
      pending: '等待执行',
      in_progress: '执行中',
      completed: '已完成',
      failed: '失败',
    };
    const state =
      finished && ['pending', 'in_progress'].includes(item.status)
        ? '已结束'
        : (labels[item.status] ?? item.status ?? '');
    const content = (item.content ?? [])
      .map((c: any, i: number) => toolContent(c, `${key}/${i}`))
      .join('');
    return `<div class="tool"><details data-detail="${esc(key + '/tool')}"><summary><span class="tool-heading"><strong>${esc(item.title ?? item.kind ?? '工具调用')}</strong><span class="tool-status ${item.status === 'failed' ? 'failed' : ''}">${esc(state)}</span></span></summary><div class="tool-body">${content}${item.rawInput ? detail(key + '/input', '输入参数', codeBlock(json(item.rawInput))) : ''}${item.rawOutput && !content ? detail(key + '/output', '输出', codeBlock(json(item.rawOutput))) : ''}</div></details>${p && !p.outcome && !finished ? `<div class="permission"><p>需要你的确认</p>${p._meta ? codeBlock(json(p._meta), '操作详情') : ''}${p.options.map((o: any) => `<button data-permission="${esc(p.requestId)}" data-option="${esc(o.optionId)}">${esc(o.name)}</button>`).join('')}<button data-permission="${esc(p.requestId)}" data-option="">取消</button></div>` : ''}</div>`;
  }
  if (item.type === 'system_notice') {
    const labels: Record<string, string> = {
      agent_warning: 'Agent 提醒',
      chat_failed: '执行失败',
    };
    const message = [item.meta?.message, item.message, item.text].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    const label = labels[item.name] ?? item.name ?? '系统提示';
    return `<p class="subtle">${esc(label)}${message ? `：${esc(message)}` : ''}</p>`;
  }
  return '';
}
function renderAttachment(value: unknown): string {
  const parsed = attachmentReferenceSchema.safeParse(value);
  if (!parsed.success) return '<p class="subtle">附件记录不可用</p>';
  const attachment = parsed.data;
  return `<button type="button" class="attachment-card" data-open-attachment="${esc(attachment.attachmentId)}"><span>${esc(attachment.name)}<small>${esc(attachment.content.mediaType)} · ${formatAttachmentSize(attachment.content.byteLength)}</small></span><span aria-hidden="true">↗</span></button>`;
}
export function renderFileChanges(files: any, key: string): string {
  if (!Array.isArray(files) || !files.length) return '';
  return detail(
    key,
    `本回合变更 · ${files.length} 个文件`,
    `<ul class="file-changes">${files.map((f) => `<li><span>${esc(f.filePath)}</span><span class="added-count">+${Number(f.add) || 0}</span><span class="removed-count">−${Number(f.del) || 0}</span></li>`).join('')}</ul>`,
  );
}
import { attachmentReferenceSchema } from '../content-protocol';
import { formatAttachmentSize } from './attachments';
