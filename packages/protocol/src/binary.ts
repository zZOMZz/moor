/** Standard binary codecs shared by all runtimes; callers validate their wire schema first. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16384)
    binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(binary);
}
export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return decodeBase64(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
}
export const utf8 = (value: string) => new TextEncoder().encode(value);
export const readUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
