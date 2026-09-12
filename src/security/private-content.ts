export const PRIVATE_ENDPOINT_FILE_FORMAT = 'moor-private-endpoint-v1';

export function isPrivateEndpointEnvelopeValue(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getOwnPropertyDescriptor(value, 'format')?.value === PRIVATE_ENDPOINT_FILE_FORMAT
  );
}

// Private endpoint files may have arbitrary names or be copied outside their original directory.
// Recognize the structured envelope, not a substring in an ordinary source file or document.
// Callers retain their own content-size bounds before passing bytes here.
export function isPrivateEndpointEnvelope(bytes: Uint8Array): boolean {
  try {
    return isPrivateEndpointEnvelopeValue(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    return false;
  }
}
