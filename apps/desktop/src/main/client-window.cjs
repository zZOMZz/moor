const { CLIENT_SCHEME, createClientAssetHandler } = require('./client-assets.cjs');
const {
  PACKAGED_CLIENT,
  confirmDevelopmentServer,
  allowsClientResource,
} = require('./client-policy.cjs');

const CLIENT_PARTITION = 'persist:moor-secure-client-v1';

async function prepareClientSession(session, publicRoot, policy = PACKAGED_CLIENT) {
  const handler = policy.development ? undefined : await createClientAssetHandler({ publicRoot });
  if (policy.development) await confirmDevelopmentServer(policy);
  session.setPermissionRequestHandler((_, __, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
  // Business traffic belongs to finite main-process IPC. Even a new renderer
  // API or navigation cannot turn this into an arbitrary HTTP client. Development
  // permits only its explicitly selected program-resource and HMR server.
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowsClientResource(policy, details.url) });
  });
  if (handler) session.protocol.handle(CLIENT_SCHEME, handler);
}

function createClientWindow({
  BrowserWindow,
  session,
  origin,
  preloadPath,
  registry,
  invalidate,
  platform = process.platform,
  clientPolicy = PACKAGED_CLIENT,
}) {
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 390,
    minHeight: 550,
    title: 'Moor',
    ...(platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      session,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = window.webContents;
  registry.set(contents, { window, origin, trustedClient: true, clientPolicy });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navigate = (event, url) => {
    if (url !== clientPolicy.url) event.preventDefault();
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || event.url !== clientPolicy.url) event.preventDefault();
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
