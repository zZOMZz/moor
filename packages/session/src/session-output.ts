import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';

/** Host-authored append. JSON readers still see the same text/thought string. */
export function appendSessionText(
  doc: LoroDoc,
  sessionId: string,
  turnId: string,
  type: 'text' | 'thought',
  chunk: string,
) {
  if (doc.getMap('session').get('id') !== sessionId) throw Error('输出会话身份不匹配');
  const history = doc.getList('history');
  let turn: LoroMap | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const candidate = history.get(index);
    if (candidate instanceof LoroMap && candidate.get('id') === turnId) {
      turn = candidate;
      break;
    }
  }
  if (!turn || turn.get('role') !== 'assistant' || turn.get('finished') !== false)
    throw Error('输出不属于活动助手回合');
  const storedItems = turn.get('items');
  const items =
    storedItems === undefined ? turn.setContainer('items', new LoroList()) : storedItems;
  if (!(items instanceof LoroList)) throw Error('输出内容结构不可用');
  let item = items.length ? items.get(items.length - 1) : undefined;
  if (!(item instanceof LoroMap) || item.get('type') !== type) {
    item = items.pushContainer(new LoroMap());
    item.set('type', type);
  }
  const previous = item.get('text');
  let text: LoroText;
  if (previous instanceof LoroText) text = previous;
  else {
    if (previous !== undefined && typeof previous !== 'string') throw Error('输出文本结构不可用');
    text = item.setContainer('text', new LoroText());
    // Existing scalar text is promoted only when this exact live item receives
    // another chunk; finished history and client-authored inputs are untouched.
    if (previous) text.insert(0, previous);
  }
  if (chunk) text.insert(text.length, chunk);
  doc.commit();
}
