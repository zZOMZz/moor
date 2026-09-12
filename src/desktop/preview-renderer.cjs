// Private, bundled Electron worker. No project code is loaded by Node.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');

const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_REQUEST = 64 * 1024;
const MAX_RESOURCE = 16 * 1024 * 1024;
const PINNED_ELECTRON = '44.3.0';
const hash = (value) => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomUUID();

function serviceOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    Number(url.port || '80') < 1 ||
    url.origin !== value
  )
    throw new Error('需要明确登记的本机 HTTP 服务');
  return url;
}
function canonicalPath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    throw new Error('预览路径无效');
  const url = new URL(value, 'http://127.0.0.1');
  if (
    url.pathname + url.search + url.hash !== value ||
    decodeURIComponent(url.pathname)
      .split('/')
      .some((part) => part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))
  )
    throw new Error('预览路径无效');
  return value;
}
function viewport(value) {
  if (
    !value ||
    !Number.isInteger(value.width) ||
    value.width < 240 ||
    value.width > 1920 ||
    !Number.isInteger(value.height) ||
    value.height < 240 ||
    value.height > 1200
  )
    throw new Error('预览视口无效');
  return { width: value.width, height: value.height };
}
function requestHeaders(headers, host, websocket = false) {
  const clean = { ...headers, host };
  const named = String(headers.connection || '')
    .split(',')
    .map((v) => v.trim().toLowerCase());
  for (const name of [
    ...named,
    'proxy-authorization',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'connection',
    'upgrade',
  ])
    delete clean[name];
  if (websocket) {
    clean.connection = 'Upgrade';
    clean.upgrade = 'websocket';
  }
  return clean;
}

/** Ephemeral host-only endpoint, never exposed to the remote client; no arbitrary tunnels. */
async function createOriginProxy(origin) {
  const service = serviceOrigin(origin);
  let closed = false;
  let inflight = 0;
  const sockets = new Set();
  const upstreams = new Set();
  const track = (socket) => {
    if (closed || sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  function target(req, ws = false) {
    if (
      closed ||
      inflight >= 32 ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
    )
      throw new Error('blocked');
    const url = new URL(req.url);
    if (ws && url.protocol === 'ws:') url.protocol = 'http:';
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      req.headers.host !== service.host ||
      url.hash
    )
      throw new Error('blocked');
    canonicalPath(url.pathname + url.search);
    return url;
  }
  const server = http.createServer(
    { maxHeaderSize: 32 * 1024, requestTimeout: 20_000, headersTimeout: 10_000 },
    (req, res) => {
      let url;
      try {
        url = target(req);
      } catch {
        res.writeHead(403);
        res.end();
        return;
      }
      const declared = Number(req.headers['content-length'] || 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESOURCE) {
        res.writeHead(413);
        res.end();
        return;
      }
      inflight++;
      let sent = 0;
      let received = 0;
      const upstream = http.request(
        {
          hostname: service.hostname.replace(/^\[|\]$/g, ''),
          port: Number(service.port || '80'),
          path: url.pathname + url.search,
          method: req.method,
          headers: requestHeaders(req.headers, service.host),
          agent: false,
          timeout: 20_000,
        },
        (response) => {
          const headers = requestHeaders(response.headers, service.host);
          delete headers.host;
          // Alternate transports and reporting endpoints must not create secondary routes.
          for (const name of ['alt-svc', 'report-to', 'nel']) delete headers[name];
          res.writeHead(response.statusCode || 502, headers);
          response.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_RESOURCE) {
              upstream.destroy();
              res.destroy();
            }
          });
          response.pipe(res);
        },
      );
      upstreams.add(upstream);
      upstream.once('close', () => {
        inflight--;
        upstreams.delete(upstream);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('data', (chunk) => {
        sent += chunk.length;
        if (sent > MAX_RESOURCE) {
          req.destroy();
          upstream.destroy();
        }
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    },
  );
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  // Chromium sends even ws:// through CONNECT. This is an HTTP parser, never a raw
  // tunnel: only a subsequent verified WebSocket handshake can contact the service.
  const websocketParser = http.createServer(
    { maxHeaderSize: 32 * 1024, headersTimeout: 10_000 },
    (_req, res) => {
      res.writeHead(403, { connection: 'close' });
      res.end();
    },
  );
  websocketParser.on('clientError', (_error, socket) => socket.destroy());
  websocketParser.on('connect', (_req, socket) => socket.destroy());
  server.on('connect', (req, socket, head) => {
    const authority = service.hostname + ':' + (service.port || '80');
    if (closed || req.url !== authority || req.headers.host !== authority || head.length) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.setTimeout(10_000, () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    websocketParser.emit('connection', socket);
  });
  function forwardWebsocket(req, socket, head, nested = false) {
    let url;
    try {
      if (nested) req.url = origin + canonicalPath(req.url);
      url = target(req, true);
      if (
        req.method !== 'GET' ||
        req.headers.origin !== origin ||
        !String(req.headers.connection || '')
          .toLowerCase()
          .split(',')
          .map((v) => v.trim())
          .includes('upgrade') ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' ||
        typeof req.headers['sec-websocket-key'] !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key']) ||
        req.headers['transfer-encoding'] ||
        (req.headers['content-length'] && req.headers['content-length'] !== '0')
      )
        throw new Error('blocked');
    } catch {
      socket.destroy();
      return;
    }
    inflight++;
    const upstream = http.request({
      hostname: service.hostname.replace(/^\[|\]$/g, ''),
      port: Number(service.port || '80'),
      path: url.pathname + url.search,
      method: 'GET',
      headers: requestHeaders(req.headers, service.host, true),
      agent: false,
      timeout: 20_000,
    });
    upstreams.add(upstream);
    upstream.once('close', () => {
      inflight--;
      upstreams.delete(upstream);
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('response', () => {
      upstream.destroy();
      socket.destroy();
    });
    upstream.on('upgrade', (response, peer, tail) => {
      if (
        closed ||
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== 'websocket' ||
        response.headers['sec-websocket-accept'] !==
          crypto
            .createHash('sha1')
            .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64')
      ) {
        peer.destroy();
        socket.destroy();
        return;
      }
      track(peer);
      socket.setTimeout(0);
      const headers = requestHeaders(response.headers, service.host, true);
      delete headers.host;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(headers)
            .flatMap(([key, value]) =>
              Array.isArray(value)
                ? value.map((item) => `${key}: ${item}\r\n`)
                : [`${key}: ${value}\r\n`],
            )
            .join('') +
          '\r\n',
      );
      if (head.length) peer.write(head);
      if (tail.length) socket.write(tail);
      let bytes = 0;
      const bounded = (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) {
          socket.destroy();
          peer.destroy();
        }
      };
      socket.on('data', bounded);
      peer.on('data', bounded);
      socket.once('close', () => peer.destroy());
      peer.once('close', () => socket.destroy());
      socket.pipe(peer);
      peer.pipe(socket);
    });
    upstream.end();
  }
  server.on('upgrade', (req, socket, head) => forwardWebsocket(req, socket, head));
  websocketParser.on('upgrade', (req, socket, head) => forwardWebsocket(req, socket, head, true));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    address: '127.0.0.1:' + server.address().port,
    async close() {
      if (closed) return;
      closed = true;
      for (const request of upstreams) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// This code executes only in a private isolated world. Inputs are data, never JS or selectors.
function pageCommand(command, args) {
  let state = globalThis.__moorPreviewState;
  if (!state) {
    state = globalThis.__moorPreviewState = {
      elements: new Map(),
      revision: 0,
      roots: new WeakSet(),
    };
    state.observer = new MutationObserver(() => state.revision++);
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    addEventListener('scroll', () => state.revision++, true);
    addEventListener('resize', () => state.revision++, true);
  }
  if (state.observer.takeRecords().length) state.revision++;
  if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision)
    throw new Error('stale document');
  function describe(element) {
    const rect = element.getBoundingClientRect();
    const password = element instanceof HTMLInputElement && element.type === 'password';
    const editable =
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ![
          'password',
          'file',
          'hidden',
          'button',
          'submit',
          'reset',
          'checkbox',
          'radio',
          'image',
        ].includes(element.type)) ||
      element.isContentEditable;
    return {
      tag: element.tagName.toLowerCase().slice(0, 40),
      role: (element.getAttribute('role') || '').slice(0, 100),
      name: password
        ? ''
        : (element.getAttribute('aria-label') || element.getAttribute('title') || '').slice(0, 200),
      text:
        password ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element.isContentEditable
          ? ''
          : (element.innerText || '').slice(0, 1000),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      editable,
      password,
    };
  }
  function get() {
    const entry = state.elements.get(args.elementId);
    if (
      !entry ||
      !entry.element.isConnected ||
      JSON.stringify(describe(entry.element)) !== entry.version
    )
      throw new Error('stale');
    const rect = entry.element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    let deepest = hit;
    while (deepest?.shadowRoot?.elementFromPoint) {
      const next = deepest.shadowRoot.elementFromPoint(x, y);
      if (!next || next === deepest) break;
      deepest = next;
    }
    if (deepest !== entry.element && !entry.element.contains(deepest)) throw new Error('covered');
    return { element: entry.element, x, y, ...describe(entry.element) };
  }
  if (command === 'viewport')
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      revision: state.revision,
      url: location.href,
    };
  if (command === 'settle')
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
    );
  if (command === 'clear') {
    state.elements.clear();
    return true;
  }
  if (command === 'locate') {
    let element = document.elementFromPoint(args.x, args.y);
    while (element?.shadowRoot?.elementFromPoint) {
      if (!state.roots.has(element.shadowRoot)) {
        state.roots.add(element.shadowRoot);
        state.observer.observe(element.shadowRoot, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        state.revision++;
        throw new Error('refresh to observe shadow root');
      }
      const next = element.shadowRoot.elementFromPoint(args.x, args.y);
      if (!next || next === element) break;
      element = next;
    }
    if (!element || element.tagName === 'IFRAME' || element.tagName === 'FRAME') return null;
    const value = describe(element);
    state.elements.set(args.elementId, { element, version: JSON.stringify(value) });
    return value;
  }
  if (command === 'validate') {
    const value = get();
    delete value.element;
    return value;
  }
  if (command === 'focus') {
    const value = get();
    if (!value.editable || value.password) throw new Error('not editable');
    value.element.focus({ preventScroll: true });
    if (
      !value.element.isConnected ||
      (document.activeElement !== value.element &&
        value.element.getRootNode().activeElement !== value.element)
    )
      throw new Error('focus changed');
    if (args.replace) {
      if ('select' in value.element) value.element.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(value.element);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    return true;
  }
  throw new Error('unknown command');
}

async function runWorker() {
  const { app, BrowserWindow, session, nativeImage } = require('electron');
  if (
    process.versions.electron !== PINNED_ELECTRON ||
    !process.env.MOOR_PREVIEW_DATA ||
    !process.env.MOOR_PREVIEW_NONCE
  )
    process.exit(1);
  const nonce = process.env.MOOR_PREVIEW_NONCE;
  app.setPath('userData', process.env.MOOR_PREVIEW_DATA);
  app.commandLine.appendSwitch('disable-quic');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ::1',
  );
  app.enableSandbox();
  await app.whenReady();
  app.dock?.hide();
  session.defaultSession.webRequest.onBeforeRequest((_details, done) => done({ cancel: true }));
  const output = fs.createWriteStream('', { fd: 3, autoClose: false });
  let binding;
  let win;
  let proxy;
  let currentFrame;
  let frameDocument;
  let context;
  let documentId = id();
  let revision = 0;
  let closed = false;
  let prepared;
  let requests = 0;
  function alive() {
    if (closed || !win || win.isDestroyed()) throw new Error('预览连接已关闭');
  }
  const wc = () => {
    alive();
    return win.webContents;
  };
  async function dom(command, args = {}) {
    const contents = wc();
    if (!context) {
      const { frameTree } = await contents.debugger.sendCommand('Page.getFrameTree');
      alive();
      const result = await contents.debugger.sendCommand('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'moor-preview-private',
        grantUniveralAccess: false,
      });
      alive();
      context = result.executionContextId;
    }
    const result = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(args)})`,
      contextId: context,
      returnByValue: true,
      awaitPromise: true,
    });
    alive();
    if (result.exceptionDetails) throw new Error('页面元素已改变，请刷新预览');
    return result.result.value;
  }
  async function image() {
    const contents = wc();
    // Electron 44 invalidate() re-emits its cached offscreen backing bitmap. A paint
    // event can therefore predate an acknowledged input, even after page rAFs.
    // CDP's surface screenshot requests a renderer redraw and waits for its copy
    // result; never return the cached paint as an interaction receipt.
    const snapshot = await contents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bitmap = nativeImage.createFromBuffer(Buffer.from(snapshot.data, 'base64'));
    alive();
    const size = bitmap.getSize();
    if (size.width !== binding.viewport.width || size.height !== binding.viewport.height)
      throw new Error('预览实际视口与请求不一致');
    const bytes = bitmap.toPNG();
    if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('预览画面超过大小限制');
    return {
      mediaType: 'image/png',
      version: hash(bytes),
      byteLength: bytes.length,
      data: bytes.toString('base64'),
    };
  }
  async function capture(attempt = 0) {
    const contents = wc();
    // Let page animation-frame handlers observe input before the compositor snapshot.
    // image() separately waits for Chromium to redraw and copy the requested surface.
    await dom('settle');
    const capturingDocument = documentId;
    const observed = await dom('viewport');
    if (observed.width !== binding.viewport.width || observed.height !== binding.viewport.height)
      throw new Error('预览实际视口与请求不一致');
    const url = new URL(contents.getURL());
    if (url.origin !== binding.origin) throw new Error('页面离开已登记服务');
    const path = canonicalPath(url.pathname + url.search + url.hash);
    await dom('clear');
    const picture = await image();
    const after = await dom('viewport');
    if (
      documentId !== capturingDocument ||
      after.url !== observed.url ||
      after.revision !== observed.revision ||
      after.width !== observed.width ||
      after.height !== observed.height
    ) {
      // Only the readback repeats; a previously dispatched page interaction never does.
      if (attempt < 2) return capture(attempt + 1);
      throw new Error('页面正在变化，请刷新预览');
    }
    frameDocument = observed;
    currentFrame = {
      previewId: binding.previewId,
      frameId: id(),
      documentId,
      revision: ++revision,
      viewport: binding.viewport,
      path,
      title: contents.getTitle().slice(0, 200),
      capturedAt: new Date().toISOString(),
      image: picture,
    };
    return currentFrame;
  }
  async function frameCurrent(frameId) {
    if (!currentFrame || currentFrame.frameId !== frameId)
      throw new Error('预览画面已过期，请刷新');
    const observed = await dom('viewport');
    if (
      currentFrame.documentId !== documentId ||
      observed.url !== frameDocument.url ||
      observed.revision !== frameDocument.revision ||
      observed.width !== frameDocument.width ||
      observed.height !== frameDocument.height
    )
      throw new Error('页面已变化，请刷新预览');
  }
  async function shutdown() {
    if (closed) return;
    closed = true;
    prepared = undefined;
    currentFrame = undefined;
    const contents = win && !win.isDestroyed() ? win.webContents : undefined;
    const isolated = contents?.session;
    if (contents) {
      contents.stop();
      win.destroy();
    }
    await proxy?.close();
    await isolated?.closeAllConnections();
    await isolated?.clearStorageData();
  }
  async function execute(message) {
    if (message.nonce !== nonce || typeof message.id !== 'string' || ++requests > 10_000)
      throw new Error('预览内部请求无效');
    if (message.command === 'probe')
      return { available: true, electron: process.versions.electron };
    if (message.command === 'close') {
      await shutdown();
      return true;
    }
    if (closed) throw new Error('预览连接已关闭');
    if (message.command === 'open') {
      if (binding) throw new Error('预览连接已存在');
      binding = message.binding;
      serviceOrigin(binding.origin);
      canonicalPath(binding.startPath);
      binding.viewport = viewport(binding.viewport);
      if (typeof binding.previewId !== 'string' || binding.previewId.length > 200)
        throw new Error('预览标识无效');
      proxy = await createOriginProxy(binding.origin);
      if (closed) {
        await proxy.close();
        throw new Error('预览连接已关闭');
      }
      const isolated = session.fromPartition('moor-preview-' + id(), { cache: false });
      await isolated.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxy.address,
        proxyBypassRules: '<-loopback>',
      });
      await isolated.closeAllConnections();
      if (closed) throw new Error('预览连接已关闭');
      const expectedProxy = 'PROXY ' + proxy.address;
      if (
        (await isolated.resolveProxy(binding.origin)) !== expectedProxy ||
        (await isolated.resolveProxy('https://127.0.0.1:1')) !== expectedProxy
      )
        throw new Error('预览网络隔离不可用');
      if (closed) throw new Error('预览连接已关闭');
      isolated.setPermissionCheckHandler(() => false);
      isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
      isolated.setDevicePermissionHandler(() => false);
      isolated.on('will-download', (event, item) => {
        event.preventDefault();
        item.cancel();
      });
      isolated.webRequest.onBeforeRequest((details, done) => {
        let allowed = false;
        try {
          const url = new URL(details.url);
          if (url.protocol === 'ws:') url.protocol = 'http:';
          allowed = !closed && url.origin === binding.origin && !url.username && !url.password;
        } catch {}
        done({ cancel: !allowed });
      });
      win = new BrowserWindow({
        show: false,
        ...binding.viewport,
        useContentSize: true,
        webPreferences: {
          session: isolated,
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          plugins: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          disableDialogs: true,
          backgroundThrottling: false,
        },
      });
      const contents = wc();
      contents.setFrameRate(10);
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      if (contents.getWebRTCIPHandlingPolicy() !== 'disable_non_proxied_udp')
        throw new Error('预览网络隔离不可用');
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.on('select-file', (event) => event.preventDefault());
      contents.on('will-prevent-unload', (event) => event.preventDefault());
      contents.on('content-bounds-updated', (event) => event.preventDefault());
      const navigation = (event) => {
        try {
          if (new URL(event.url).origin === binding.origin) return;
        } catch {}
        event.preventDefault();
      };
      contents.on('will-frame-navigate', navigation);
      contents.on('will-redirect', navigation);
      contents.on('did-start-navigation', (event) => {
        if (event.isMainFrame) {
          currentFrame = undefined;
          prepared = undefined;
          context = undefined;
          documentId = id();
        }
      });
      contents.on('render-process-gone', () => void shutdown());
      contents.on('unresponsive', () => void shutdown());
      contents.debugger.attach('1.3');
      // CDP target commands are not ready until the first navigation has initialized it.
      await contents.loadURL('about:blank');
      alive();
      await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      alive();
      await contents.loadURL(binding.origin + binding.startPath);
      alive();
      await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      alive();
      return capture();
    }
    if (!binding || message.previewId !== binding.previewId) throw new Error('预览连接不匹配');
    if (message.command === 'capture') return capture();
    if (message.command === 'locate') {
      if (
        !Number.isFinite(message.x) ||
        !Number.isFinite(message.y) ||
        message.x < 0 ||
        message.y < 0 ||
        message.x >= binding.viewport.width ||
        message.y >= binding.viewport.height
      )
        throw new Error('预览坐标无效');
      await frameCurrent(message.frameId);
      const elementId = id();
      const value = await dom('locate', {
        x: message.x,
        y: message.y,
        elementId,
        expectedRevision: frameDocument.revision,
      });
      return value ? { elementId, frameId: message.frameId, ...value } : null;
    }
    if (message.command === 'prepare') {
      const request = message.request;
      if (!request || request.previewId !== binding.previewId) throw new Error('预览操作无效');
      await frameCurrent(request.frameId);
      if (request.action === 'click' || request.action === 'input') {
        const element = await dom('validate', {
          elementId: request.elementId,
          expectedRevision: frameDocument.revision,
        });
        if (
          request.action === 'input' &&
          (!element.editable ||
            element.password ||
            typeof request.text !== 'string' ||
            request.text.length > 4000 ||
            request.text.includes('\0') ||
            typeof request.replace !== 'boolean')
        )
          throw new Error('当前元素不支持输入');
      } else if (request.action === 'resize') viewport(request.viewport);
      else if (request.action === 'navigate') canonicalPath(request.path);
      else if (
        request.action === 'key' &&
        ![
          'Enter',
          'Tab',
          'Escape',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Backspace',
          'Delete',
        ].includes(request.key)
      )
        throw new Error('按键不支持');
      else if (
        request.action === 'scroll' &&
        (!Number.isInteger(request.deltaX) ||
          !Number.isInteger(request.deltaY) ||
          Math.abs(request.deltaX) > 4000 ||
          Math.abs(request.deltaY) > 4000)
      )
        throw new Error('滚动范围无效');
      else if (!['key', 'scroll', 'reload'].includes(request.action))
        throw new Error('预览操作无效');
      prepared = { id: id(), request };
      return { preparedId: prepared.id };
    }
    if (message.command === 'dispatch') {
      if (!prepared || message.preparedId !== prepared.id) throw new Error('预览操作已失效');
      const request = prepared.request;
      prepared = undefined;
      const contents = wc();
      await frameCurrent(request.frameId);
      if (request.action === 'click') {
        const element = await dom('validate', {
          elementId: request.elementId,
          expectedRevision: frameDocument.revision,
        });
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: element.x,
          y: element.y,
          button: 'left',
          clickCount: 1,
        });
        alive();
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: element.x,
          y: element.y,
          button: 'left',
          clickCount: 1,
        });
        alive();
      } else if (request.action === 'input') {
        await dom('focus', {
          elementId: request.elementId,
          replace: request.replace,
          expectedRevision: frameDocument.revision,
        });
        await contents.debugger.sendCommand('Input.insertText', { text: request.text });
        alive();
      } else if (request.action === 'key') {
        const keyCodes = {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          ArrowUp: 38,
          ArrowDown: 40,
          ArrowLeft: 37,
          ArrowRight: 39,
          Backspace: 8,
          Delete: 46,
        };
        await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: request.key,
          code: request.key,
          windowsVirtualKeyCode: keyCodes[request.key],
          ...(request.key === 'Enter' ? { text: '\r' } : {}),
        });
        alive();
        await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: request.key,
          code: request.key,
          windowsVirtualKeyCode: keyCodes[request.key],
        });
        alive();
      } else if (request.action === 'scroll') {
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: binding.viewport.width / 2,
          y: binding.viewport.height / 2,
          deltaX: request.deltaX,
          deltaY: request.deltaY,
        });
        alive();
      } else if (request.action === 'resize') {
        binding.viewport = viewport(request.viewport);
        win.setContentSize(binding.viewport.width, binding.viewport.height);
      } else if (request.action === 'navigate') {
        await contents.loadURL(binding.origin + canonicalPath(request.path));
        alive();
      } else if (request.action === 'reload') {
        await contents.loadURL(binding.origin + currentFrame.path);
        alive();
      }
      return capture();
    }
    throw new Error('预览内部请求无效');
  }
  let chain = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (Buffer.byteLength(line) > MAX_REQUEST) {
      void shutdown().finally(() => app.exit(1));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      void shutdown().finally(() => app.exit(1));
      return;
    }
    const run = async () => {
      try {
        const result = await execute(message);
        output.write(JSON.stringify({ id: message.id, nonce, ok: true, result }) + '\n');
      } catch (error) {
        output.write(
          JSON.stringify({
            id: message.id,
            nonce,
            ok: false,
            message: [
              '预览实际视口与请求不一致',
              '页面正在变化，请刷新预览',
              '预览画面已过期，请刷新',
              '页面已变化，请刷新预览',
              '页面元素已改变，请刷新预览',
              '预览连接已关闭',
              '当前元素不支持输入',
            ].includes(error?.message)
              ? error.message
              : '预览操作失败，连接或页面可能已变化',
          }) + '\n',
        );
      }
    };
    // Closing must interrupt an open or pending navigation instead of queuing behind it.
    if (message.command === 'close' && message.nonce === nonce) void run();
    else chain = chain.then(run, run);
  });
  input.on('close', () => void shutdown().finally(() => app.quit()));
  process.on('SIGTERM', () => void shutdown().finally(() => app.quit()));
  output.write(JSON.stringify({ nonce, ready: true, electron: process.versions.electron }) + '\n');
}

module.exports = { createOriginProxy, serviceOrigin, canonicalPath };
// Electron's require.main is its own bootstrap, not the application's CommonJS module.
if (process.versions.electron && process.env.MOOR_PREVIEW_NONCE)
  void runWorker().catch(() => process.exit(1));
