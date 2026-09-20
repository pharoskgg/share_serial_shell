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

/** Keep enough history for exporting long-running terminal sessions. */
export const SESSION_HISTORY_LIMIT = 30 * 1024 * 1024;

interface AgentUnit {
  entries: Entry[];
  cursor: number;
}

function rawBytes(entry: Entry): Buffer {
  return entry.base64 !== undefined ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.data);
}

function mergeEntries(entries: Entry[], type: Entry['type']): Entry {
  const bytes = Buffer.concat(entries.map(rawBytes));
  return {
    ...entries[0],
    seq: entries.at(-1)!.seq,
    type,
    data: type === 'status' ? entries.map(entry => entry.data).join('') : bytes.toString('utf8'),
    ...(type === 'status' ? {} : { base64: bytes.toString('base64') }),
  };
}

function isImmediateEcho(input: Entry, output: Entry): boolean {
  return output.type === 'output' && rawBytes(input).equals(rawBytes(output));
}

/**
 * Present terminal keystrokes as coherent bursts to agents. The retained history
 * stays byte-for-byte and event-for-event unchanged for the UI and export.
 *
 * A typical native terminal produces `input h, output h, input e, output e`.
 * Those echo pairs become one input event plus one output event, and are kept in
 * one pagination unit so a cursor can never split or lose the reordered echo.
 */
function agentUnits(entries: Entry[]): AgentUnit[] {
  const units: AgentUnit[] = [];
  for (let index = 0; index < entries.length;) {
    const first = entries[index];
    if (first.type !== 'input' || first.actor !== 'human') {
      units.push({ entries: [first], cursor: first.seq }); index++; continue;
    }
    const inputs: Entry[] = [];
    const echoes: Entry[] = [];
    const actor = first.actor;
    let cursor = first.seq;
    while (index < entries.length) {
      const input = entries[index];
      if (input.type !== 'input' || input.actor !== actor) { break; }
      inputs.push(input); cursor = input.seq; index++;
      if (index < entries.length && isImmediateEcho(input, entries[index])) {
        echoes.push(entries[index]); cursor = entries[index].seq; index++;
      }
      if (/[\r\n]$/.test(input.data)) { break; }
    }
    const compacted = [mergeEntries(inputs, 'input')];
    if (echoes.length) { compacted.push(mergeEntries(echoes, 'output')); }
    units.push({ entries: compacted, cursor });
  }
  return units;
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
  constructor(readonly kind: SessionKind, readonly name: string, private readonly historyLimit = SESSION_HISTORY_LIMIT) { super(); }

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
    // Count the original payload, rather than JSON/base64 overhead, so the
    // configured limit describes the amount of text/bytes users can retain.
    this.bytes += raw?.byteLength ?? Buffer.byteLength(data);
    while (this.bytes > this.historyLimit && this.entries.length > 1) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.base64 ? Buffer.from(removed.base64, 'base64').byteLength : Buffer.byteLength(removed.data);
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

  /** Return the currently retained history for local export without exposing the mutable array. */
  history(): Entry[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  readForAgent(after = 0, limit = 50, format: 'text' | 'raw' = 'text') {
    const requested = this.read(after, limit);
    const cutoff = requested.events.at(-1)?.seq ?? after;
    // `limit` normally bounds source events. Read a bounded look-ahead so that
    // the last human keystroke burst can finish instead of being split merely
    // because every key and its echo consumed two source-event slots.
    const read = requested.events.length === limit ? this.read(after, limit + 1000) : requested;
    const events: object[] = [];
    let size = 0;
    let nextCursor = after;
    for (const unit of agentUnits(read.events)) {
      const candidate = events.map(event => ({ ...event })) as any[];
      let candidateSize = size;
      for (const entry of unit.entries) {
        const event: any = format === 'raw' ? { ...entry } : { seq: entry.seq, type: entry.type, actor: entry.actor, data: entry.data };
        const previous = candidate.at(-1) as ({ seq: number; type: Entry['type']; data: string; base64?: string } | undefined);
        if (previous?.type === 'output' && entry.type === 'output') {
          const merged = { ...previous, seq: entry.seq, data: previous.data + event.data };
          if (format === 'raw' && previous.base64 !== undefined && event.base64 !== undefined) {
            merged.base64 = Buffer.concat([
              Buffer.from(previous.base64, 'base64'), Buffer.from(event.base64, 'base64'),
            ]).toString('base64');
          }
          const previousSize = Buffer.byteLength(JSON.stringify(previous));
          const mergedSize = Buffer.byteLength(JSON.stringify(merged));
          if (candidateSize - previousSize + mergedSize <= 8192) {
            candidate[candidate.length - 1] = merged;
            candidateSize = candidateSize - previousSize + mergedSize;
            continue;
          }
        }
        candidate.push(event); candidateSize += Buffer.byteLength(JSON.stringify(event));
      }
      // Echo-compacted input/output pairs are atomic so pagination cannot skip
      // an echo that was moved behind the complete human input burst.
      if (events.length && candidateSize > 8192) { break; }
      events.splice(0, events.length, ...candidate);
      size = candidateSize; nextCursor = unit.cursor;
      if (unit.cursor >= cutoff) { break; }
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
