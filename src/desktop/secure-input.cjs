const MAX_NODES = 100000;
const MAX_DEPTH = 64;

/**
 * Admit and independently copy JSON values without first cloning hidden binary
 * storage or serializing an unbounded object. IPC can otherwise carry Map,
 * ArrayBuffer and other structured-clone values invisible to JSON byte counts.
 * @param {unknown} input
 * @param {number} limit
 * @returns {{value: any, bytes: number}}
 */
function snapshotSecureInput(input, limit) {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set();
  const reject = () => {
    throw new Error('Invalid secure JSON request');
  };
  const consume = (count) => {
    bytes += count;
    if (bytes > limit) reject();
  };
  const string = (value) => {
    // An oversized primitive must fail before allocating its escaped JSON form.
    if (Buffer.byteLength(value) > limit - bytes) reject();
    consume(Buffer.byteLength(JSON.stringify(value)));
  };
  const visit = (value, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return reject();
    if (value === null) {
      consume(4);
      return null;
    }
    if (typeof value === 'boolean') {
      consume(value ? 4 : 5);
      return value;
    }
    if (typeof value === 'string') {
      string(value);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return reject();
      consume(String(value).length);
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) return reject();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      (!array && proto !== Object.prototype && proto !== null) ||
      (array && value.length > MAX_NODES - nodes)
    )
      return reject();
    ancestors.add(value);
    consume(2);
    const result = array ? [] : {};
    let count = 0;
    // Symbols, accessors, sparse arrays and non-enumerable properties are not a
    // JSON request. Inspect descriptors so no getter or toJSON hook can run.
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return reject();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return reject();
      if (array && key !== String(count)) return reject();
      if (count++) consume(1);
      if (!array) {
        string(key);
        consume(1);
      }
      const child = visit(descriptor.value, depth + 1);
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && count !== value.length) return reject();
    ancestors.delete(value);
    return result;
  };
  if (!Number.isSafeInteger(limit) || limit < 1) return reject();
  return { value: visit(input, 0), bytes };
}

module.exports = { snapshotSecureInput };
