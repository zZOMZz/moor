import { z } from 'zod';

export const PERMISSION_REVIEW_FEATURE = 'permission-review-v1';
export const PERMISSION_REVIEW_MAX_BYTES = 256 * 1024;
export const permissionOptionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
export const permissionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('selected'), optionId: permissionOptionIdSchema }).strict(),
  z.object({ outcome: z.literal('cancelled') }).strict(),
]);

// Cache serialization, never an approval decision. Only a fully validated,
// deeply frozen input can retain the same reviewed contents across snapshots.
const immutableItemJson = new WeakMap<object, string>();

/** Bound complete tool input before exposing it as review material. No Agent getters/hooks execute. */
export function permissionItemJson(input: unknown): string {
  const cached = input && typeof input === 'object' ? immutableItemJson.get(input) : undefined;
  if (cached !== undefined) return cached;
  let nodes = 0,
    characters = 0,
    immutable = true;
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
    if (!Object.isFrozen(value)) immutable = false;
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
  if (immutable && input && typeof input === 'object') immutableItemJson.set(input, result);
  return result;
}
