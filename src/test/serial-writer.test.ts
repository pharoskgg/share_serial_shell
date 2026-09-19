import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialWriter } from '../serial-writer';

test('serial pacing counts bytes, drains before waiting, and keeps concurrent writes in FIFO order', async () => {
  const chunks: Buffer[] = [], times: number[] = [];
  const writer = new SerialWriter(async bytes => {
    chunks.push(Buffer.from(bytes)); times.push(performance.now());
    await new Promise(resolve => setTimeout(resolve, 8)); // Simulated driver drain.
  });
  const first = Buffer.from('你好世界');
  await Promise.all([writer.write(first), writer.write(Buffer.from([0, 255, 13, 10, 65]))]);
  assert.deepEqual(chunks.map(chunk => chunk.length), [4, 4, 4, 4, 1]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, Buffer.from([0, 255, 13, 10, 65])]));
  for (let i = 1; i < times.length; i++) { assert.ok(times[i] - times[i - 1] >= 12, 'Drain plus pacing must apply between calls too'); }
  writer.close();
});

test('disconnect aborts an in-flight driver call and all queued writes', async () => {
  let calls = 0;
  const writer = new SerialWriter(async () => { calls++; await new Promise(() => {}); });
  const first = assert.rejects(writer.write(Buffer.alloc(8)), /disconnected/);
  const second = assert.rejects(writer.write(Buffer.alloc(4)));
  await new Promise(resolve => setImmediate(resolve));
  writer.close();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('a partial write failure cancels subsequent commands; overflow is bounded', async () => {
  let calls = 0;
  const writer = new SerialWriter(async () => { if (++calls === 2) { throw new Error('driver failed'); } });
  await Promise.all([
    assert.rejects(writer.write(Buffer.alloc(8)), /driver failed/),
    assert.rejects(writer.write(Buffer.alloc(4))),
    assert.rejects(writer.write(Buffer.alloc(16384)), /queue full/),
  ]);
  assert.equal(calls, 2);
});
