import { memo, useState } from 'react';
import { markdownInline, plainCode } from '../../components/content';

type Kind = 'paragraph' | 'ordered' | 'unordered' | 'heading' | 'quote' | 'code';
type Block = {
  kind: Kind;
  parts: readonly string[];
  level?: number;
  label?: string;
  size?: number;
  truncated?: boolean;
};
type Cursor = { blocks: readonly Block[]; active?: 'paragraph' | 'ordered' | 'unordered' | 'code' };
type Document = {
  source: string;
  offset: number;
  complete: Cursor;
  blocks: readonly Block[];
  /** A plain, non-fence code line whose displayed prefix cannot be reinterpreted
   * by an append. ANSI/CR and provisional fences use the conservative parser. */
  codeTail?: Cursor;
};
const previewLimit = 120_000;
const segmentSize = 4096;
const boundary = (line: string) => /^(?:\s*$|```|#{1,6} |[-*] |\d+\. |> )/.test(line);

// A bounded mutable tail inside otherwise stable parts. Code is split by visible
// characters; paragraph segments are joined only at complete inline/line boundaries.
function appendParts(parts: readonly string[], value: string, code = false): readonly string[] {
  if (!value) return parts.length ? parts : [''];
  const next = [...parts];
  if (code) {
    let offset = 0;
    const boundary = (end: number) =>
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value[end - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(value[end] ?? '')
        ? end - 1
        : end;
    if (next.length && next.at(-1)!.length < segmentSize) {
      const take = boundary(Math.min(segmentSize - next.at(-1)!.length, value.length));
      next[next.length - 1] += value.slice(0, take);
      offset = take;
    }
    while (offset < value.length) {
      const end = boundary(Math.min(offset + segmentSize, value.length));
      next.push(value.slice(offset, end));
      offset = end;
    }
  } else if (next.length && next.at(-1)!.length + value.length <= segmentSize) {
    next[next.length - 1] += value;
  } else next.push(value);
  return next;
}

function appendCode(state: Cursor, value: string): Cursor {
  const last = state.blocks.at(-1)!;
  if (last.truncated) return state;
  const size = (last.size ?? 0) + value.length;
  return {
    active: 'code',
    blocks: [
      ...state.blocks.slice(0, -1),
      {
        ...last,
        parts: appendParts(last.parts, value.slice(0, previewLimit - (last.size ?? 0)), true),
        size: Math.min(size, previewLimit),
        truncated: size > previewLimit,
      },
    ],
  };
}

function line(state: Cursor, text: string): Cursor {
  const last = state.blocks.at(-1);
  const replace = (block: Block, active: Cursor['active']): Cursor => ({
    blocks: [...state.blocks.slice(0, -1), block],
    active,
  });
  if (state.active === 'code' && last) {
    if (/^```\s*$/.test(text)) return { blocks: state.blocks };
    if (last.truncated) return state;
    const value = (last.parts.length ? '\n' : '') + plainCode(text);
    return appendCode(state, value);
  }
  if (!text.trim()) return { blocks: state.blocks };
  if (state.active === 'paragraph' && last && !boundary(text))
    return replace(
      { ...last, parts: appendParts(last.parts, '<br>' + markdownInline(text)) },
      'paragraph',
    );
  if (
    last &&
    ((state.active === 'ordered' && /^\d+\. /.test(text)) ||
      (state.active === 'unordered' && /^[-*] /.test(text)))
  )
    return replace(
      { ...last, parts: [...last.parts, markdownInline(text.replace(/^(?:\d+\. |[-*] )/, ''))] },
      state.active,
    );
  let block: Block;
  let active: Cursor['active'];
  const fence = text.match(/^```([^`]*)$/);
  const heading = text.match(/^(#{1,6}) ([^\n]*)$/);
  if (fence) {
    block = { kind: 'code', label: fence[1]!.trim() || '代码', parts: [], size: 0 };
    active = 'code';
  } else if (heading) {
    block = {
      kind: 'heading',
      level: Math.min(heading[1]!.length + 1, 6),
      parts: [markdownInline(heading[2]!)],
    };
  } else if (/^(?:[-*] |\d+\. )/.test(text)) {
    active = /^\d/.test(text) ? 'ordered' : 'unordered';
    block = { kind: active, parts: [markdownInline(text.replace(/^(?:\d+\. |[-*] )/, ''))] };
  } else if (text.startsWith('> ')) {
    block = { kind: 'quote', parts: [markdownInline(text.slice(2))] };
  } else {
    active = 'paragraph';
    block = { kind: active, parts: [markdownInline(text)] };
  }
  return { blocks: [...state.blocks, block], active };
}

/** Complete source lines become checkpoints. Ordinary code tails reuse their
 * visible prefix; inline syntax, ANSI, fences and CR waiting for LF are reparsed.
 * No published cursor is mutated, so interrupted React renders remain safe. */
function update(previous: Document | undefined, source: string): Document {
  const append = previous && source.startsWith(previous.source);
  let complete: Cursor = append ? previous.complete : { blocks: [] };
  let offset = append ? previous.offset : 0;
  // A trailing high surrogate can join the next chunk. Rebuild that provisional
  // line so a complete Unicode character never ends up in two separate spans.
  if (append && previous.codeTail && !/[\uD800-\uDBFF]/.test(previous.source.at(-1)!)) {
    const suffix = source.slice(previous.source.length);
    const newline = suffix.indexOf('\n');
    const addition = newline < 0 ? suffix : suffix.slice(0, newline);
    if (!/[\x1b\r]/.test(addition)) {
      const tail = appendCode(previous.codeTail, addition);
      if (newline < 0) return { source, offset, complete, blocks: tail.blocks, codeTail: tail };
      complete = tail;
      offset = previous.source.length + newline + 1;
    }
  }
  for (let end = source.indexOf('\n', offset); end !== -1; end = source.indexOf('\n', offset)) {
    let value = source.slice(offset, end);
    if (value.endsWith('\r')) value = value.slice(0, -1);
    complete = line(complete, value);
    offset = end + 1;
  }
  const text = source.slice(offset);
  const tail = line(complete, text);
  return {
    source,
    offset,
    complete,
    blocks: tail.blocks,
    ...(complete.active === 'code' && text && !text.startsWith('`') && !/[\x1b\r]/.test(text)
      ? { codeTail: tail }
      : {}),
  };
}

const InlinePart = memo(function InlinePart({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
});
const CodePart = memo(function CodePart({ text }: { text: string }) {
  return <span>{text}</span>;
});
const ListPart = memo(function ListPart({ html }: { html: string }) {
  return <li dangerouslySetInnerHTML={{ __html: html }} />;
});
const CopyCode = memo(function CopyCode({ block }: { block: Block }) {
  const [copied, setCopied] = useState<readonly string[]>();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      data-copy
      title={
        failed
          ? '无法访问剪贴板，请选择代码后手动复制'
          : block.truncated
            ? '复制当前显示的代码预览'
            : '复制代码'
      }
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(block.parts.join(''));
          setCopied(block.parts);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      }}
    >
      {failed ? '复制失败' : copied === block.parts ? '已复制' : '复制'}
    </button>
  );
});
const MarkdownBlock = memo(function MarkdownBlock({ block }: { block: Block }) {
  if (block.kind === 'code')
    return (
      <div className="code-block">
        <div className="code-toolbar">
          <span>{block.label}</span>
          <CopyCode block={block} />
        </div>
        <pre>
          <code>
            {block.parts.map((text, index) => (
              <CodePart key={index} text={text} />
            ))}
          </code>
        </pre>
        {block.truncated && <small>输出预览已截断；完整记录保留在执行电脑。</small>}
      </div>
    );
  if (block.kind === 'ordered' || block.kind === 'unordered') {
    const Tag = block.kind === 'ordered' ? 'ol' : 'ul';
    return (
      <Tag>
        {block.parts.map((html, index) => (
          <ListPart key={index} html={html} />
        ))}
      </Tag>
    );
  }
  if (block.kind === 'heading') {
    const Tag = `h${block.level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    return <Tag dangerouslySetInnerHTML={{ __html: block.parts[0]! }} />;
  }
  if (block.kind === 'quote')
    return <blockquote dangerouslySetInnerHTML={{ __html: block.parts[0]! }} />;
  return (
    <p>
      {block.parts.map((html, index) => (
        <InlinePart key={index} html={html} />
      ))}
    </p>
  );
});

export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const [document, setDocument] = useState(() => update(undefined, text));
  if (document.source !== text) {
    setDocument(update(document, text));
    // React retries this component before committing its children. Avoid
    // constructing the same block tree in both the discarded and final render.
    return null;
  }
  return (
    <div className="session-message-text">
      <div className="markdown">
        {document.blocks.map((block, index) => (
          <MarkdownBlock key={index} block={block} />
        ))}
      </div>
    </div>
  );
});
