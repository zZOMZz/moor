export const PERMISSION_REVIEW_FEATURE = 'permission-review-v1';
export const PERMISSION_REVIEW_MAX_BYTES = 256 * 1024;

/** Bound complete tool input before exposing it as review material. No Agent getters/hooks execute. */
export function permissionItemJson(input: unknown): string {
  let nodes = 0,
    characters = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 32) throw Error('审批内容超出审阅限制。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > PERMISSION_REVIEW_MAX_BYTES) throw Error('审批内容超出审阅限制。');
      return value;
    }
    if (!value || typeof value !== 'object') throw Error('审批内容格式不受支持。');
    if (Array.isArray(value)) {
      if (value.length > 10000) throw Error('审批内容超出审阅限制。');
      const array: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) throw Error('审批内容格式不受支持。');
        array.push(visit(descriptor.value, depth + 1));
      }
      return array;
    }
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value)))
      throw Error('审批内容格式不受支持。');
    const keys = Object.keys(value).sort();
    if (keys.length > 10000) throw Error('审批内容超出审阅限制。');
    return Object.fromEntries(
      keys.flatMap((key) => {
        characters += key.length;
        if (characters > PERMISSION_REVIEW_MAX_BYTES) throw Error('审批内容超出审阅限制。');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw Error('审批内容格式不受支持。');
        return descriptor.value === undefined ? [] : [[key, visit(descriptor.value, depth + 1)]];
      }),
    );
  };
  const result = JSON.stringify(visit(input, 0));
  if (new TextEncoder().encode(result).byteLength > PERMISSION_REVIEW_MAX_BYTES)
    throw Error('审批内容超出审阅限制。');
  return result;
}
