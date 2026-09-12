import { z } from 'zod';
import { projectFilePathSchema } from './content-protocol';
import { SEARCH_LIMITS, searchEntrySchema, type SearchEntry } from './search-protocol';
import type { ProjectSnapshotDiff } from './runtime/project-snapshot';

export type SearchDocument = { entries: SearchEntry[]; partial: boolean };
// Only the host can supply a frozen snapshot from its saved diff store. itemIndex
// is an existing, stable turn-item anchor selected by the host for navigation.
export type FrozenSearchDiff = {
  frozen: true;
  turnId: string;
  itemIndex: number;
  diff: Readonly<ProjectSnapshotDiff>;
};
const frozenFileSchema = z.object({
  path: projectFilePathSchema,
  state: z.enum(['text', 'binary', 'oversize', 'unavailable']),
  text: z.string().optional(),
});
const frozenChangeSchema = z
  .object({
    path: projectFilePathSchema,
    previousPath: projectFilePathSchema.optional(),
    kind: z.enum(['added', 'deleted', 'modified', 'renamed']),
    before: frozenFileSchema.nullable(),
    after: frozenFileSchema.nullable(),
  })
  .refine((change) => !!change.before || !!change.after)
  .refine((change) => !change.before || change.before.path === (change.previousPath ?? change.path))
  .refine((change) => !change.after || change.after.path === change.path);

function sliceText(value: string, start: number, end: number) {
  // Avoid creating lone surrogates when enforcing code-unit transport limits.
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/u.test(value[start] ?? '') &&
    /[\uD800-\uDBFF]/u.test(value[start - 1])
  )
    start--;
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(value[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(value[end] ?? '')
  )
    end--;
  return value.slice(start, end);
}

/** Host-owned search projection. Attachments, raw arguments and metadata are excluded. */
export function sessionSearchDocument(
  history: readonly any[],
  frozenDiffs: readonly FrozenSearchDiff[] = [],
): SearchDocument {
  const result: SearchDocument = { entries: [], partial: false };
  let bytes = 0,
    visited = 0;
  const add = (entry: SearchEntry) => {
    if (!entry.text) return;
    if (entry.text.length > SEARCH_LIMITS.text) {
      result.partial = true;
      entry = { ...entry, text: sliceText(entry.text, 0, SEARCH_LIMITS.text) };
    }
    const parsed = searchEntrySchema.safeParse(entry);
    if (!parsed.success) {
      result.partial = true;
      return;
    }
    const size = new TextEncoder().encode(parsed.data.text).byteLength;
    if (
      result.entries.length >= SEARCH_LIMITS.entries ||
      bytes + size > SEARCH_LIMITS.documentBytes
    ) {
      result.partial = true;
      return;
    }
    result.entries.push(parsed.data);
    bytes += size;
  };
  const exhausted = () => {
    if (++visited > SEARCH_LIMITS.entries * 4) {
      result.partial = true;
      return true;
    }
    return false;
  };
  history: for (const turn of history) {
    if (exhausted()) break;
    if (typeof turn?.id !== 'string' || !Array.isArray(turn.items)) continue;
    for (let itemIndex = 0; itemIndex < turn.items.length; itemIndex++) {
      if (exhausted()) break history;
      const item = turn.items[itemIndex],
        base = { turnId: turn.id, itemIndex };
      if (['text', 'thought'].includes(item?.type) && typeof item.text === 'string')
        add({ ...base, kind: 'message', text: item.text });
      if (item?.type !== 'tool_call') continue;
      if (typeof item.title === 'string') add({ ...base, kind: 'tool', text: item.title });
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (exhausted()) break history;
        if (
          content?.type === 'content' &&
          content.content?.type === 'text' &&
          typeof content.content.text === 'string'
        )
          add({ ...base, kind: 'tool', text: content.content.text });
        if (content?.type === 'diff' && typeof content.path === 'string') {
          const text = [content.path, content.oldText, content.newText]
            .filter((value) => typeof value === 'string')
            .join('\n');
          add({ ...base, kind: 'diff', path: content.path, text });
        }
      }
    }
  }
  snapshots: for (const input of frozenDiffs) {
    if (exhausted()) break;
    if (
      input?.frozen !== true ||
      input.diff?.version !== 1 ||
      input.diff.basis !== 'project-snapshot' ||
      !Array.isArray(input.diff.changes)
    ) {
      result.partial = true;
      continue;
    }
    if (input.diff.partial) result.partial = true;
    for (const raw of input.diff.changes) {
      if (exhausted()) break snapshots;
      const change = frozenChangeSchema.safeParse(raw);
      if (!change.success) {
        result.partial = true;
        continue;
      }
      const { path, previousPath, before, after } = change.data;
      const text = [
        previousPath,
        path,
        before?.state === 'text' ? before.text : undefined,
        after?.state === 'text' ? after.text : undefined,
      ]
        .filter((value) => typeof value === 'string')
        .join('\n');
      add({ turnId: input.turnId, itemIndex: input.itemIndex, kind: 'diff', path, text });
    }
  }
  return result;
}

export function searchExcerpt(body: string, foldedPosition: number) {
  // Lowercasing can expand characters (e.g. U+0130). Map the match back to its
  // original offset before slicing, keeping the returned text faithful.
  let original = 0,
    folded = 0;
  for (const character of body) {
    if (folded >= foldedPosition) break;
    original += character.length;
    folded += character.toLowerCase().length;
  }
  const start = Math.max(0, original - 100),
    end = Math.min(body.length, start + 700);
  return (start ? '…' : '') + sliceText(body, start, end) + (end < body.length ? '…' : '');
}
