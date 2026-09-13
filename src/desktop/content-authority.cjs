const { CLIENT_ORIGIN, isTrustedClientUrl } = require('./client-assets.cjs');

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
    const target = new URL(registered.origin);
    if (
      !['https:', 'http:'].includes(target.protocol) ||
      target.origin !== registered.origin ||
      target.username ||
      target.password
    )
      return false;
    if (registered.trustedClient === true)
      return isTrustedClientUrl(frame.url) && frame.origin === CLIENT_ORIGIN;
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
