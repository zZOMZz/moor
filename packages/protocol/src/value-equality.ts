/** Equality for protocol data, binary versions and local immutable scope descriptors.
 * This is a pure value operation shared by every runtime. */
export function sameValue(a: unknown, b: unknown): boolean {
  return compare(a, b, new WeakMap<object, object>());
}
function compare(a: unknown, b: unknown, seen: WeakMap<object, object>): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((byte, index) => byte === right[index]);
  }
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer)
    return (
      a.byteLength === b.byteLength &&
      new Uint8Array(a).every((byte, index) => byte === new Uint8Array(b)[index])
    );
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a)
      if (!b.has(key) || !compare(value, b.get(key), seen)) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set)
    return a.size === b.size && [...a].every((value) => b.has(value));
  const keys = Reflect.ownKeys(a).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(a, key),
  );
  const other = Reflect.ownKeys(b).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(b, key),
  );
  if (keys.length !== other.length) return false;
  for (const key of keys) {
    if (
      !Object.prototype.propertyIsEnumerable.call(b, key) ||
      !compare(Reflect.get(a, key), Reflect.get(b, key), seen)
    )
      return false;
  }
  return !Array.isArray(a) || (Array.isArray(b) && a.length === b.length);
}
