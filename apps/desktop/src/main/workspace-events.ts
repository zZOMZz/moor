import { WebSocket, type ClientOptions } from 'ws';
import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import type { DesktopWorkspaceChange } from '@moor/client/workspace-protocol';

type Notice = Pick<DesktopWorkspaceChange, 'kind' | 'deviceId' | 'workspaceId' | 'sessionId'>;
const changedSchema = z.object({
  type: z.literal('changed'),
  deviceId: id,
  workspaceId: id.optional(),
  room: z.object({ scope: z.string(), docId: id.optional() }).optional(),
});

/** A native-owned invalidation feed; no renderer URL, credential or socket access. */
export class WorkspaceEvents {
  #socket?: Pick<WebSocket, 'on' | 'terminate'>;
  #cancel?: () => void;
  #closed = false;
  #attempt = 0;
  constructor(
    private readonly options: {
      origin: string;
      cookie: string;
      current(): void;
      changed(value: Notice): void;
      socket?(url: URL, options: ClientOptions): Pick<WebSocket, 'on' | 'terminate'>;
      schedule?(ms: number, callback: () => void): () => void;
    },
  ) {
    this.#connect();
  }
  #notify(value: Notice) {
    if (this.#closed) return;
    try {
      this.options.current();
      this.options.changed(value);
    } catch {
      this.close();
    }
  }
  #connect() {
    if (this.#closed) return;
    try {
      this.options.current();
    } catch {
      this.close();
      return;
    }
    try {
      const url = new URL('/events', this.options.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = (this.options.socket ?? ((url, options) => new WebSocket(url, options)))(url, {
        headers: { Cookie: this.options.cookie, Origin: this.options.origin },
        followRedirects: false,
        maxPayload: 4096,
        handshakeTimeout: 10_000,
      });
      this.#socket = socket;
      socket.on('open', () => {
        if (socket !== this.#socket) return;
        this.#attempt = 0;
        this.#notify({ kind: 'connected' });
      });
      socket.on('message', (raw, binary) => {
        if (this.#closed || socket !== this.#socket || binary) return;
        try {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (bytes.byteLength > 4096) return;
          const value = changedSchema.parse(JSON.parse(bytes.toString()));
          if (value.room && value.room.scope !== 'doc') return;
          this.#notify({
            kind: 'changed',
            deviceId: value.deviceId,
            ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}),
            ...(value.room?.docId ? { sessionId: value.room.docId } : {}),
          });
        } catch {
          // Invalid notices cannot supply a document or cause an operation.
        }
      });
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        if (socket !== this.#socket) return;
        this.#socket = undefined;
        this.#reconnect();
      });
    } catch {
      this.#reconnect();
    }
  }
  #reconnect() {
    this.#notify({ kind: 'disconnected' });
    if (this.#closed) return;
    const schedule =
      this.options.schedule ??
      ((ms, callback) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.#cancel = schedule(Math.min(30_000, 1000 * 2 ** this.#attempt++), () => {
      this.#cancel = undefined;
      this.#connect();
    });
  }
  close() {
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.terminate();
  }
}
