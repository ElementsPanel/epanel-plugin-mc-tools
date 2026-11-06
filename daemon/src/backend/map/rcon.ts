import { createConnection, type Socket } from "node:net";

const MAX_RESPONSE = 1024 * 1024;
function packet(id: number, type: number, text: string) {
  const body = Buffer.from(text), bytes = Buffer.alloc(body.length + 14);
  bytes.writeInt32LE(body.length + 10); bytes.writeInt32LE(id, 4); bytes.writeInt32LE(type, 8); body.copy(bytes, 12);
  return bytes;
}

export interface RconTarget { host: string; port: number; password: string }
interface Pending {
  id: number; end?: number; endSent?: boolean; auth: boolean; chunks: Buffer[]; size: number;
  resolve(value: string): void; reject(error: Error): void;
}

/** One reusable authenticated connection. Timeouts apply to active reads, never idle time. */
export class RconConnection {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private failure?: Error;
  private pending?: Pending;
  private authenticated = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cancelled = () => this.close();

  constructor(private readonly target: RconTarget, private readonly signal: AbortSignal, private readonly timeout = 8000) {
    signal.throwIfAborted();
    this.socket = createConnection({ host: target.host, port: target.port });
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 30_000);
    this.socket.unref();
    signal.addEventListener("abort", this.cancelled, { once: true });
    this.socket.on("error", this.cancelled);
    this.socket.on("end", this.cancelled);
    this.socket.on("close", this.cancelled);
    this.socket.on("data", chunk => this.receive(chunk));
  }

  get closed() { return !!this.failure; }

  close(error = new Error("MC_MAP_RCON_UNAVAILABLE")) {
    if (this.failure) return;
    this.failure = error;
    this.pending?.reject(error); this.pending = undefined;
    this.buffer = Buffer.alloc(0);
    this.signal.removeEventListener("abort", this.cancelled);
    this.socket.destroy();
  }

  run<T>(read: (command: (text: string) => Promise<string>) => Promise<T>): Promise<T> {
    // Keep each roster's commands together, including when several maps share an instance.
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const timer = setTimeout(() => this.close(), this.timeout);
      try {
        if (!this.authenticated) { await this.send(this.target.password, true); this.authenticated = true; }
        const value = await read(command => this.send(command));
        if (this.failure) throw this.failure;
        return value;
      } finally { clearTimeout(timer); }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private receive(chunk: Buffer) {
    if (this.failure) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_RESPONSE) throw new Error("MC_MAP_RCON_RESPONSE");
      while (this.buffer.length >= 4) {
        const size = this.buffer.readInt32LE(0);
        if (size < 10 || size > MAX_RESPONSE) throw new Error("MC_MAP_RCON_RESPONSE");
        if (this.buffer.length < size + 4) break;
        const bytes = this.buffer.subarray(0, size + 4); this.buffer = this.buffer.subarray(size + 4);
        if (bytes[size + 2] || bytes[size + 3]) throw new Error("MC_MAP_RCON_RESPONSE");
        const id = bytes.readInt32LE(4), type = bytes.readInt32LE(8), body = bytes.subarray(12, size + 2), request = this.pending;
        if (id === -1) throw new Error("MC_MAP_RCON_AUTH");
        if (!request) continue;
        if (request.auth && id === request.id && type === 2) { this.pending = undefined; request.resolve(""); }
        else if (!request.auth && id === request.end && type === 0) { this.pending = undefined; request.resolve(Buffer.concat(request.chunks).toString("utf8")); }
        else if (!request.auth && id === request.id && type === 0) {
          request.size += body.length;
          if (request.size > MAX_RESPONSE) throw new Error("MC_MAP_RCON_RESPONSE");
          request.chunks.push(body);
          // Vanilla (including 26.2) rejects two requests coalesced in one read.
          // Wait for a response before sending the delimiter, then collect all
          // remaining chunks until that delimiter's reply arrives.
          if (!request.endSent) { request.endSent = true; this.socket.write(packet(request.end!, 2, "")); }
        }
      }
    } catch (error) { this.close(error instanceof Error && /^MC_MAP_RCON_[A-Z_]+$/.test(error.message) ? error : new Error("MC_MAP_RCON_RESPONSE")); }
  }

  private send(text: string, auth = false) {
    return new Promise<string>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (this.pending || text.includes("\0") || Buffer.byteLength(text) > 1446) return reject(new Error("MC_MAP_RCON_RESPONSE"));
      if (this.nextId > 0x7ffffffd) this.nextId = 1;
      const id = this.nextId++, end = auth ? undefined : this.nextId++;
      this.pending = { id, end, auth, chunks: [], size: 0, resolve, reject };
      try { this.socket.write(packet(id, auth ? 3 : 2, text)); }
      catch { this.close(); }
    });
  }
}
