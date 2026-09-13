import { Duplex } from 'node:stream';
import type { EncryptedBridgeTimers } from './encrypted-bridge';

const frameOverhead = 256;
type Message = { bytes: number; charge: number; fragments: number };
type Frame = { remaining: number; final: boolean; message?: Message; charge: number };
type IngressOptions = {
  budget: EncryptedIngressBudget;
  messageBytes(): number;
  timers: EncryptedBridgeTimers;
  fail(): void;
  forward(bytes: Buffer): void;
  maxFragments?: number;
  messageMs?: number;
};

/** Shared by both v4 endpoints and every account in one relay. */
export class EncryptedIngressBudget {
  #usedBytes = 0;
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error('Invalid ingress budget');
  }
  get usedBytes(): number {
    return this.#usedBytes;
  }
  reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes - this.#usedBytes)
      return false;
    this.#usedBytes += bytes;
    return true;
  }
  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#usedBytes)
      throw Error('Invalid ingress release');
    this.#usedBytes -= bytes;
  }
}

/**
 * A framing admission gate, before ws assembles messages. It never unmasks,
 * decodes JSON or interprets ciphertext. ws still validates the full protocol.
 * Each declared frame payload is reserved before even its header is forwarded.
 */
export class EncryptedIngress {
  readonly #options: IngressOptions;
  readonly #header = Buffer.allocUnsafeSlow(14);
  readonly #held = new Set<Message>();
  readonly #completed: Message[] = [];
  #headerBytes = 0;
  #headerLength = 2;
  #frame?: Frame;
  #block?: Buffer;
  #blockBytes = 0;
  #controlCharge = 0;
  #message?: Message;
  #timer?: unknown;
  #timerGeneration = 0;
  #closed = false;
  #closing = false;

  constructor(options: IngressOptions) {
    this.#options = options;
  }

  receive(bytes: Buffer): void {
    if (this.#closed || this.#closing || bytes.length === 0) return;
    try {
      let offset = 0;
      while (offset < bytes.length && !this.#closed && !this.#closing) {
        if (this.#timer === undefined) {
          const generation = ++this.#timerGeneration;
          this.#timer = this.#options.timers.set(() => {
            if (generation === this.#timerGeneration) this.#reject();
          }, this.#options.messageMs ?? 30000);
        }
        if (!this.#frame) {
          const count = Math.min(this.#headerLength - this.#headerBytes, bytes.length - offset);
          bytes.copy(this.#header, this.#headerBytes, offset, offset + count);
          offset += count;
          this.#headerBytes += count;
          if (this.#headerBytes !== this.#headerLength) continue;
          if (this.#headerLength === 2) {
            const first = this.#header[0],
              opcode = first & 15,
              length = this.#header[1] & 127;
            if (
              (first & 112) !== 0 ||
              (this.#header[1] & 128) === 0 ||
              ![0, 1, 8, 9, 10].includes(opcode) ||
              (opcode === 0 ? !this.#message : opcode === 1 && !!this.#message) ||
              (opcode >= 8 && (!(first & 128) || length > 125 || (opcode === 8 && length === 1)))
            )
              throw Error('Invalid frame');
            this.#headerLength = length === 127 ? 14 : length === 126 ? 8 : 6;
            continue;
          }
          const frame = this.#admit();
          this.#frame = frame;
          const header = this.#header.subarray(0, this.#headerLength);
          if (frame.remaining === 0) this.#finishFrame(frame);
          this.#forward(header);
          if (frame.remaining === 0 && !frame.message) this.#releaseControl();
          continue;
        }
        const frame = this.#frame;
        // Bound receiver buffer objects even when TCP delivers one byte at a time.
        this.#block ??= Buffer.allocUnsafeSlow(Math.min(frame.remaining, 64 * 1024));
        const count = Math.min(this.#block.length - this.#blockBytes, bytes.length - offset);
        bytes.copy(this.#block, this.#blockBytes, offset, offset + count);
        this.#blockBytes += count;
        frame.remaining -= count;
        offset += count;
        if (this.#blockBytes === this.#block.length) {
          const block = this.#block;
          this.#block = undefined;
          this.#blockBytes = 0;
          if (frame.remaining === 0) this.#finishFrame(frame);
          this.#options.forward(block);
          if (frame.remaining === 0 && !frame.message) this.#releaseControl();
        }
      }
      this.#clearIdleTimer();
    } catch {
      this.#reject();
    }
  }

  /** Called in finally after the synchronous ws message handler has finished. */
  completeMessage(): void {
    if (this.#closed) return;
    const message = this.#completed.shift();
    if (!message || !this.#held.delete(message)) {
      this.#reject();
      return;
    }
    this.#options.budget.release(message.charge);
    this.#clearIdleTimer();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.timers.clear(this.#timer);
    this.#timer = undefined;
    this.#timerGeneration++;
    for (const message of this.#held) this.#options.budget.release(message.charge);
    this.#releaseControl();
    this.#held.clear();
    this.#completed.length = 0;
    this.#message = this.#frame = undefined;
    this.#block = undefined;
    this.#blockBytes = 0;
  }

  #admit(): Frame {
    const opcode = this.#header[0] & 15,
      final = !!(this.#header[0] & 128);
    let length = this.#header[1] & 127;
    if (length === 126) {
      length = this.#header.readUInt16BE(2);
      if (length < 126) throw Error('Invalid length');
    } else if (length === 127) {
      const wide = this.#header.readBigUInt64BE(2);
      if (wide < 65536n || wide > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid length');
      length = Number(wide);
    }
    const charge = length + frameOverhead;
    const message =
      opcode < 8 ? (this.#message ?? { bytes: 0, charge: 0, fragments: 0 }) : undefined;
    if (
      message &&
      (length > this.#options.messageBytes() - message.bytes ||
        message.fragments >= (this.#options.maxFragments ?? 1024))
    )
      throw Error('Message limit');
    if (!this.#options.budget.reserve(charge)) throw Error('Ingress limit');
    if (message) {
      message.bytes += length;
      message.charge += charge;
      message.fragments++;
      this.#held.add(message);
      this.#message = message;
    } else this.#controlCharge = charge;
    return { remaining: length, final, message, charge };
  }

  #finishFrame(frame: Frame): void {
    if (frame.message && frame.final) {
      // Queue before forwarding the final bytes: ws can emit message synchronously.
      this.#completed.push(frame.message);
      this.#message = undefined;
    }
    if ((this.#header[0] & 15) === 8) this.#closing = true;
    this.#frame = undefined;
    this.#headerBytes = 0;
    this.#headerLength = 2;
  }

  #forward(bytes: Buffer): void {
    // A tiny fragment must not pin the unrelated tail of a large TCP chunk or a
    // pooled allocation. The receiver only retains exactly admitted payload.
    const owned = Buffer.allocUnsafeSlow(bytes.length);
    bytes.copy(owned);
    this.#options.forward(owned);
  }

  #clearIdleTimer(): void {
    if (!this.#frame && !this.#held.size && this.#headerBytes === 0) {
      this.#options.timers.clear(this.#timer);
      this.#timer = undefined;
      this.#timerGeneration++;
    }
  }

  #releaseControl(): void {
    this.#options.budget.release(this.#controlCharge);
    this.#controlCharge = 0;
  }

  #reject(): void {
    if (this.#closed) return;
    this.close();
    this.#options.fail();
  }
}

/** Public Duplex boundary; no ws private receiver hooks or socket data bypass. */
export class EncryptedIngressSocket extends Duplex {
  readonly #source: Duplex;
  readonly #ingress: EncryptedIngress;
  #started = false;

  constructor(
    source: Duplex,
    options: {
      budget: EncryptedIngressBudget;
      messageBytes(): number;
      timers: EncryptedBridgeTimers;
      maxFragments: number;
      messageMs: number;
    },
  ) {
    super({
      readableHighWaterMark: 64 * 1024,
      writableHighWaterMark: 64 * 1024,
      allowHalfOpen: false,
    });
    this.#source = source;
    source.pause();
    const network = source as Duplex & {
      setTimeout?(ms: number): void;
      setNoDelay?(enabled: boolean): void;
    };
    network.setTimeout?.(0);
    network.setNoDelay?.(true);
    this.#ingress = new EncryptedIngress({
      ...options,
      fail: () => this.destroy(),
      forward: (bytes) => {
        if (!this.push(bytes)) source.pause();
      },
    });
    source.on('data', (bytes: Buffer) => this.#ingress.receive(bytes));
    source.on('end', () => this.push(null));
    source.on('error', (error) => this.destroy(error));
    source.on('close', () => this.destroy());
  }

  start(head: Buffer): void {
    if (this.#started || this.destroyed) return;
    this.#started = true;
    this.#ingress.receive(head);
    if (!this.destroyed && this.readableLength < this.readableHighWaterMark) this.#source.resume();
  }
  completeMessage(): void {
    this.#ingress.completeMessage();
  }
  override _read(): void {
    if (this.#started) this.#source.resume();
  }
  override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#source.write(bytes, callback);
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.#source.end(callback);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#ingress.close();
    this.#source.destroy();
    callback(error);
  }
}
