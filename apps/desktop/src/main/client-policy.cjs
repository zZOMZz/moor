const { CLIENT_URL, CLIENT_ORIGIN } = require('./client-assets.cjs');

const PACKAGED_CLIENT = Object.freeze({ url: CLIENT_URL, origin: CLIENT_ORIGIN });

// Policies are supplied by main when registering a window, never by an IPC caller.
function clientDocumentMatches(registered, frame) {
  const policy = registered?.clientPolicy ?? PACKAGED_CLIENT;
  return frame?.url === policy.url && frame?.origin === policy.origin;
}

function developmentClientPolicy({ enabled, isPackaged, rendererUrl, token }) {
  if (!enabled || isPackaged) return undefined;
  const url = new URL(rendererUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    ![url.href, url.origin].includes(rendererUrl) ||
    !/^[a-f0-9]{64}$/.test(token ?? '')
  )
    throw new Error('Invalid desktop development server');
  return Object.freeze({ url: url.href, origin: url.origin, token, development: true });
}

async function confirmDevelopmentServer(policy, request = globalThis.fetch) {
  const response = await request(policy.origin + '/__moor_dev__/identity', {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || (await response.text()) !== policy.token)
    throw new Error('Desktop development server identity mismatch');
}

function allowsClientResource(policy, value) {
  if (!policy.development) return value.startsWith(CLIENT_ORIGIN + '/');
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.origin === policy.origin ||
        (url.protocol === 'ws:' &&
          url.host === new URL(policy.origin).host &&
          url.pathname === '/__moor_dev__/hmr'))
    );
  } catch {
    return false;
  }
}

module.exports = {
  PACKAGED_CLIENT,
  clientDocumentMatches,
  developmentClientPolicy,
  confirmDevelopmentServer,
  allowsClientResource,
};
