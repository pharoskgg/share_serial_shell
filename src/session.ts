import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type SessionKind = 'local' | 'ssh' | 'serial';
export interface Backend {
  write(data: Buffer): Promise<void> | void;
  resize?(cols: number, rows: number): void;
  close(): void;
}
export interface Entry {
  seq: number;
  time: string;
  type: 'output' | 'input' | 'status';
  actor?: 'human' | 'ai';
  data: string;
  base64?: string;
}

/** One shared byte stream. Neither actor takes a lock or pauses the other. */
export class Session extends EventEmitter {
  readonly id = randomUUID();
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  private backend?: Backend;
  private entries: Entry[] = [];
  private sequence = 0;
  private bytes = 0;
  private readonly outputDecoder = new StringDecoder('utf8');
  constructor(readonly kind: SessionKind, readonly name: string, private readonly historyLimit = 1024 * 1024) { super(); }

  attach(backend: Backend): void {
    if (this.state === 'closed') { backend.close(); return; }
    this.backend = backend;
    this.state = 'open';
    this.record('status', 'Connected');
    this.emit('change');
  }

  private record(type: Entry['type'], data: string, actor?: Entry['actor'], raw?: Buffer): Entry {
    const entry: Entry = { seq: ++this.sequence, time: new Date().toISOString(), type, data, actor };
    if (raw) { entry.base64 = raw.toString('base64'); }
    this.entries.push(entry);
    this.bytes += Buffer.byteLength(JSON.stringify(entry));
    while (this.bytes > this.historyLimit && this.entries.length > 1) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.shift()!));
    }
    this.emit('entry', entry);
    return entry;
  }

  output(raw: Buffer | string): void {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    // Bound individual records even when a backend emits a very large chunk.
    for (let i = 0; i < bytes.length; i += 8192) {
      const chunk = bytes.subarray(i, i + 8192);
      // Keep incomplete UTF-8 sequences across driver chunks. The base64 field
      // still preserves each exact chunk for raw readers.
      this.record('output', this.outputDecoder.write(chunk), undefined, chunk);
      this.emit('data', chunk);
    }
  }

  async write(data: Buffer, actor: 'human' | 'ai'): Promise<void> {
    if (this.state !== 'open' || !this.backend) { throw new Error('Session is not open'); }
    if (data.length > 16384) { throw new Error('Each write is limited to 16384 bytes; split larger input'); }
    // Record before dispatch, including escape/control bytes even if the device does not echo.
    this.record('input', data.toString('utf8'), actor, data);
    try { await this.backend.write(data); }
    catch (error) { this.record('status', `Write failed: ${String(error)}`); throw error; }
  }

  resize(cols: number, rows: number): void { this.backend?.resize?.(cols, rows); }
  status(message: string): void { this.record('status', message); }

  read(after = 0, limit = 200) {
    const first = this.entries[0]?.seq ?? this.sequence + 1;
    const events = this.entries.filter(entry => entry.seq > after).slice(0, limit);
    return {
      sessionId: this.id, state: this.state, events,
      nextCursor: events.at(-1)?.seq ?? after,
      latestCursor: this.sequence, truncated: after < first - 1,
    };
  }

  readForAgent(after = 0, limit = 50, format: 'text' | 'raw' = 'text') {
    const read = this.read(after, limit);
    const events: object[] = [];
    let size = 0;
    let nextCursor = after;
    for (const entry of read.events) {
      const event: any = format === 'raw' ? { ...entry } : { seq: entry.seq, type: entry.type, actor: entry.actor, data: entry.data };
      const previous = events.at(-1) as ({ seq: number; type: Entry['type']; data: string; base64?: string } | undefined);
      if (previous?.type === 'output' && entry.type === 'output') {
        const merged = { ...previous, seq: entry.seq, data: previous.data + event.data };
        if (format === 'raw' && previous.base64 !== undefined && event.base64 !== undefined) {
          merged.base64 = Buffer.concat([
            Buffer.from(previous.base64, 'base64'), Buffer.from(event.base64, 'base64'),
          ]).toString('base64');
        }
        const previousSize = Buffer.byteLength(JSON.stringify(previous));
        const mergedSize = Buffer.byteLength(JSON.stringify(merged));
        if (size - previousSize + mergedSize <= 8192) {
          events[events.length - 1] = merged;
          size = size - previousSize + mergedSize;
          nextCursor = entry.seq;
          continue;
        }
      }
      const bytes = Buffer.byteLength(JSON.stringify(event));
      // Always include one complete event so cursors progress without losing bytes.
      if (events.length && size + bytes > 8192) { break; }
      events.push(event); size += bytes; nextCursor = entry.seq;
    }
    return { state: read.state, events, nextCursor, hasMore: nextCursor < read.latestCursor,
      ...(read.truncated ? { truncated: true } : {}) };
  }

  async waitForEntries(after: number, waitMs: number, settleMs = 0): Promise<void> {
    if (this.sequence <= after && this.state !== 'closed' && waitMs > 0) {
      await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.off('entry', done); resolve(); };
      const timer = setTimeout(done, waitMs);
      this.once('entry', done);
      });
    }
    // Once at least one event is available, hold the response open for a short,
    // bounded aggregation window so a burst of serial driver chunks is returned
    // together. This is not a command-completion detector.
    if (settleMs > 0 && this.sequence > after && this.state !== 'closed') {
      await new Promise<void>(resolve => setTimeout(resolve, settleMs));
    }
  }

  close(reason = 'Closed'): void {
    if (this.state === 'closed') { return; }
    this.state = 'closed';
    const backend = this.backend;
    this.backend = undefined;
    try { backend?.close(); } catch { /* Already disconnected. */ }
    const tail = this.outputDecoder.end();
    if (tail) { this.record('output', tail); }
    this.record('status', reason);
    this.emit('change');
    this.emit('closed');
  }
  info() { return { id: this.id, name: this.name, kind: this.kind, state: this.state }; }
}

export class Sessions extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  create(kind: SessionKind, name: string): Session {
    // Closed histories remain readable, but do not accumulate indefinitely.
    for (const [id, session] of this.sessions) {
      if (this.sessions.size < 64) { break; }
      if (session.state === 'closed') { this.sessions.delete(id); }
    }
    if (this.sessions.size >= 64) { throw new Error('Session limit reached (64); close unused sessions'); }
    const session = new Session(kind, name);
    this.sessions.set(session.id, session);
    session.on('entry', (entry: Entry) => this.emit('entry', session, entry));
    session.on('change', () => this.emit('change'));
    this.emit('created', session);
    this.emit('change');
    return session;
  }
  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) { throw new Error(`Unknown session: ${id}`); }
    return session;
  }
  list(): Session[] { return [...this.sessions.values()]; }
  dispose(): void { for (const session of this.sessions.values()) { session.close(); } }
}
