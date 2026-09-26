export const esc = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function markdownInline(text: string): string {
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
export function plainCode(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
export function codeBlock(text: string, label = '代码'): string {
  // Only display a bounded preview of large tool output; never run terminal escape sequences or HTML.
  const limit = 120_000;
  const value = plainCode(text);
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
      const m = line.match(/^(#{1,6}) ([^\n]*)$/)!;
      const n = Math.min(m[1].length + 1, 6);
      html += `<h${n}>${markdownInline(m[2])}</h${n}>`;
    } else if (/^([-*] |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line),
        re = ordered ? /^\d+\. / : /^[-*] /;
      const items = [line.replace(re, '')];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>${items.map((s) => `<li>${markdownInline(s)}</li>`).join('')}</${tag}>`;
    } else if (line.startsWith('> '))
      html += `<blockquote>${markdownInline(line.slice(2))}</blockquote>`;
    else {
      const p = [line];
      while (i < lines.length && !boundary(lines[i])) p.push(lines[i++]);
      html += `<p>${p.map(markdownInline).join('<br>')}</p>`;
    }
  }
  return `<div class="markdown">${html}</div>`;
}
