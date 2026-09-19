import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_HISTORY_LIMIT, Session, Sessions } from '../session';

test('default session history retains at least 30 MiB of serialized text', () => {
  assert.equal(SESSION_HISTORY_LIMIT, 30 * 1024 * 1024);
  const session = new Session('local', 'large history');
  session.output(Buffer.alloc(2 * 1024 * 1024, 65));
  assert.equal(session.read(0, Number.MAX_SAFE_INTEGER).truncated, false);
});

test('human and AI input share the backend without taking over or pausing', async () => {
  const session = new Session('serial', 'test');
  const writes: Buffer[] = [];
  session.attach({ write: bytes => { writes.push(bytes); }, close() {} });
  await session.write(Buffer.from('AI\r'), 'ai');
  await session.write(Buffer.from('\x03'), 'human');
  await session.write(Buffer.from([0, 255, 13, 10]), 'ai');
  assert.deepEqual(writes, [Buffer.from('AI\r'), Buffer.from('\x03'), Buffer.from([0, 255, 13, 10])]);
  const entries = session.read().events.filter(entry => entry.type === 'input');
  assert.deepEqual(entries.map(entry => entry.actor), ['ai', 'human', 'ai']);
  assert.deepEqual(Buffer.from(entries[2].base64!, 'base64'), writes[2]);
});

test('independent readers, bounded history, long polling, and closed writes', async () => {
  const session = new Session('local', 'test', 700);
  session.attach({ write() {}, close() {} });
  const cursor = session.read().latestCursor;
  const waiting = session.waitForEntries(cursor, 1000);
  session.output('hello');
  await waiting;
  assert.deepEqual(session.read(cursor), session.read(cursor));
  for (let i = 0; i < 20; i++) { session.output('1234567890'.repeat(10)); }
  assert.equal(session.read(0).truncated, true);
  assert.ok(session.read().events.length < 20);
  session.close();
  await assert.rejects(session.write(Buffer.from('no'), 'ai'), /not open/);
});

test('closing during connection prevents backend adoption and cleans up', () => {
  const session = new Session('ssh', 'test');
  session.close();
  let closed = 0;
  session.attach({ write() {}, close() { closed++; } });
  assert.equal(closed, 1);
  assert.equal(session.state, 'closed');
});

test('large writes are rejected before dispatch and recorded history has a session cap', async () => {
  const session = new Session('serial', 'test');
  let dispatched = false;
  session.attach({ write() { dispatched = true; }, close() {} });
  await assert.rejects(session.write(Buffer.alloc(16385), 'ai'), /16384/);
  assert.equal(dispatched, false);
  const sessions = new Sessions();
  for (let i = 0; i < 64; i++) { sessions.create('local', String(i)); }
  assert.throws(() => sessions.create('local', 'extra'), /limit/);
  sessions.list()[0].close();
  sessions.create('local', 'replacement');
  assert.equal(sessions.list().length, 64);
  sessions.dispose();
});

test('compact reads paginate without dropping output and raw reads preserve binary data', () => {
  const session = new Session('serial', 'read budget');
  for (let i = 0; i < 20; i++) { session.output(Buffer.alloc(1000, i)); }
  let cursor = 0;
  let received = Buffer.alloc(0);
  let pageCount = 0;
  for (;;) {
    const read = session.readForAgent(cursor, 50, 'raw');
    assert.ok(JSON.stringify(read.events).length < 8300);
    for (const event of read.events as any[]) {
      received = Buffer.concat([received, Buffer.from(event.base64 ?? '', 'base64')]);
    }
    pageCount++;
    cursor = read.nextCursor;
    if (!read.hasMore) { break; }
  }
  assert.ok(pageCount >= 3, '8 KiB agent pages should paginate the 20 KiB stream');
  assert.equal(cursor, session.read().latestCursor);
  assert.equal(received.length, 20_000);
  for (let i = 0; i < 20; i++) { assert.equal(received[i * 1000], i); }
  const raw = session.readForAgent(0, 1, 'raw').events[0] as any;
  assert.deepEqual(Buffer.from(raw.base64, 'base64'), Buffer.alloc(1000));
  assert.ok(raw.time);
});

test('agent reads coalesce adjacent serial chunks, preserve cursors, and keep raw bytes', () => {
  const session = new Session('serial', 'coalesced output');
  session.output(Buffer.from([0xe4, 0xb8]));
  session.output(Buffer.from([0xad, 0x0d, 0x0a]));
  const text = session.readForAgent(0, 50, 'text');
  const output = text.events.filter((event: any) => event.type === 'output') as any[];
  assert.equal(output.length, 1);
  assert.equal(output[0].data, '中\r\n');
  assert.equal(text.nextCursor, session.read().latestCursor);
  const raw = session.readForAgent(0, 50, 'raw').events.filter((event: any) => event.type === 'output') as any[];
  assert.equal(raw.length, 1);
  assert.deepEqual(Buffer.from(raw[0].base64, 'base64'), Buffer.from([0xe4, 0xb8, 0xad, 0x0d, 0x0a]));
});

test('settle window collects a serial burst without claiming command completion', async () => {
  const session = new Session('serial', 'settled output');
  session.output('first');
  setTimeout(() => session.output(' second'), 20);
  await session.waitForEntries(0, 0, 70);
  const read = session.readForAgent(0, 50, 'text');
  assert.equal((read.events.find((event: any) => event.type === 'output') as any).data, 'first second');
  assert.equal(read.hasMore, false);
});
