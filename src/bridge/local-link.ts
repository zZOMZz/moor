import { createConnection, type Socket } from 'node:net';
import {
  createJsonLineSplitter,
  LocalLoroDataPlaneServerMessageSchema,
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
} from '@lody/shared/local-loro-data-plane';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
export class LocalLink implements LocalLoroDataPlaneConnection {
  socket: Socket | null = null;
  connected = false;
  stopped = false;
  retry: ReturnType<typeof setTimeout> | undefined;
  listeners = new Set<(v: any) => void>();
  status = new Set<(v: boolean) => void>();
  ping: ReturnType<typeof setInterval>;
  constructor(public path: string) {
    this.ping = setInterval(() => {
      if (this.connected) this.send({ type: 'ping', protocolVersion: 7 });
    }, 15000);
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const socket = createConnection(this.path);
    this.socket = socket;
    const split = createJsonLineSplitter({
      maxBufferBytes: LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
      onOverflow: () => socket.destroy(),
      onLine: (line) => {
        try {
          const result = LocalLoroDataPlaneServerMessageSchema.safeParse(JSON.parse(line));
          if (!result.success) {
            socket.destroy();
            return;
          }
          for (const f of this.listeners) f(result.data);
        } catch {
          socket.destroy();
        }
      },
    });
    socket.on('data', split);
    socket.on('connect', () => {
      this.connected = true;
      for (const f of this.status) f(true);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connected = false;
      for (const f of this.status) f(false);
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 1500);
    });
  }
  send(message: any) {
    if (!this.connected || !this.socket) throw new Error('本地 Lody 未连接');
    if (this.socket.writableLength > 64 * 1024 * 1024) {
      this.socket.destroy();
      throw new Error('本地连接拥塞');
    }
    this.socket.write(JSON.stringify(message) + '\n');
  }
  isConnected = () => this.connected;
  onMessage = (f: (v: any) => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
  onStatusChange = (f: (v: boolean) => void) => {
    this.status.add(f);
    return () => this.status.delete(f);
  };
  close() {
    this.stopped = true;
    clearInterval(this.ping);
    clearTimeout(this.retry);
    this.socket?.destroy();
  }
}
