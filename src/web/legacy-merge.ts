import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
export const legacyObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function operationId(value: unknown): unknown {
  if (!legacyObject(value)) return undefined;
  const request = legacyObject(value.request) ? value.request : undefined;
  const operation = legacyObject(value.operation) ? value.operation : undefined;
  const body = operation && legacyObject(operation.body) ? operation.body : undefined;
  const mutation = body && legacyObject(body.mutation) ? body.mutation : undefined;
  return value.operationId ?? request?.operationId ?? body?.operationId ?? mutation?.operationId;
}
/** Three-way recovery. Current edits win; an unknown original is always atomic. */
export function mergeLegacyToolState(
  previous: unknown,
  incoming: unknown,
  local: unknown,
  field = '',
  depth = 0,
): unknown {
  if (same(previous, incoming) || incoming === undefined) return structuredClone(local);
  if (depth <= 1 && ['pending', 'operation', 'delivery'].includes(field)) {
    if (
      previous &&
      operationId(previous) &&
      operationId(previous) === operationId(incoming) &&
      !same(previous, incoming)
    )
      throw Error('同一旧工具操作编号的内容发生变化，不能覆盖原请求。');
    if (local && !same(local, incoming))
      throw Error('此工具还有另一份未确认原请求，请先核查原操作后恢复更新。');
    return structuredClone(incoming);
  }
  if (depth <= 1 && ['target', 'route'].includes(field) && local && !same(local, incoming))
    throw Error('旧工具的执行身份发生变化，不能替换原目标。');
  if (local === undefined) {
    if (legacyObject(previous) && legacyObject(incoming))
      for (const key of Object.keys(incoming))
        mergeLegacyToolState(previous[key], incoming[key], undefined, key, depth + 1);
    return structuredClone(incoming);
  }
  if (
    depth <= 1 &&
    ['resources', 'closed'].includes(field) &&
    Array.isArray(local) &&
    Array.isArray(incoming)
  ) {
    const values = new Map([...local, ...incoming].map((value) => [canonical(value), value]));
    return structuredClone([...values.values()]);
  }
  if (legacyObject(incoming) && legacyObject(local)) {
    const result: Record<string, unknown> = {};
    const before = legacyObject(previous) ? previous : {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
      if (depth === 0 && key === 'cacheRevision') continue;
      const value = mergeLegacyToolState(before[key], incoming[key], local[key], key, depth + 1);
      if (value !== undefined)
        Object.defineProperty(result, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    return result;
  }
  return structuredClone(same(local, previous) || same(local, incoming) ? incoming : local);
}
