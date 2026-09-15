const { clientDocumentMatches } = require('./client-policy.cjs');

// This establishes only a current content document. Callers must separately
// authorize its business role, configured service, account and operation scope.
function isCurrentContentDocument(registered, contents, frame) {
  try {
    if (
      !registered ||
      !registered.window ||
      registered.window.isDestroyed() ||
      !contents ||
      contents.isDestroyed() ||
      registered.window.webContents !== contents ||
      !frame ||
      frame !== contents.mainFrame
    )
      return false;
    // A packaged local-only window may have no configured relay. Non-empty
    // registrations still require a canonical HTTP service origin below.
    if (registered.trustedClient === true && registered.origin === '')
      return clientDocumentMatches(registered, frame);
    const target = new URL(registered.origin);
    if (
      !['https:', 'http:'].includes(target.protocol) ||
      target.origin !== registered.origin ||
      target.username ||
      target.password
    )
      return false;
    if (registered.trustedClient === true) return clientDocumentMatches(registered, frame);
    // A custom scheme's Node URL.origin is "null". It is never HTTP authority,
    // and accepting it here would authorize unrelated opaque documents.
    const document = new URL(frame.url);
    return (
      ['https:', 'http:'].includes(document.protocol) &&
      document.origin === registered.origin &&
      frame.origin === registered.origin
    );
  } catch {
    return false;
  }
}

module.exports = { isCurrentContentDocument };
