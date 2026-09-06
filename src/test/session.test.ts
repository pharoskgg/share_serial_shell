import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Sessions } from '../session';

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
