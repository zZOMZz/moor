const {
  CLIENT_SCHEME,
  CLIENT_ORIGIN,
  CLIENT_URL,
  createClientAssetHandler,
} = require('./client-assets.cjs');

const CLIENT_PARTITION = 'persist:moor-secure-client-v1';

async function prepareClientSession(session, publicRoot) {
  const handler = await createClientAssetHandler({ publicRoot });
  session.setPermissionRequestHandler((_, __, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
  // Business traffic belongs to finite main-process IPC. Even a new renderer
  // API or a navigational request cannot turn this session into an HTTP client.
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(CLIENT_ORIGIN + '/') });
  });
  session.protocol.handle(CLIENT_SCHEME, handler);
}

function createClientWindow({ BrowserWindow, session, origin, preloadPath, registry, invalidate }) {
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 390,
    minHeight: 550,
    title: 'Moor',
    webPreferences: {
      session,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = window.webContents;
  registry.set(contents, { window, origin, trustedClient: true });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navigate = (event, url) => {
    if (url !== CLIENT_URL) event.preventDefault();
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || event.url !== CLIENT_URL) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) invalidate(contents);
  });
  window.on('closed', () => {
    invalidate(contents);
    registry.delete(contents);
  });
  return window;
}

module.exports = { CLIENT_PARTITION, prepareClientSession, createClientWindow };
