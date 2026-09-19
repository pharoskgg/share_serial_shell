import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session';
import { TerminalTranscript } from '../terminal-transcript';

for (const kind of ['serial', 'ssh', 'local'] as const) {
  test(`${kind}: AI input is visible even without device echo, including input before terminal open`, async () => {
    const session = new Session(kind, 'no echo');
    const transcript = new TerminalTranscript(session);
    const sent: Buffer[] = [];
    session.attach({ write: bytes => { sent.push(bytes); }, close() {} });
    await session.write(Buffer.from('help\r'), 'ai');
    let screen = '';
    transcript.open(text => { screen += text; });
    assert.ok(!screen.includes('[AI →]'));
    await session.write(Buffer.from('\x03\x1b[2J\u009b2J'), 'ai');
    assert.ok(!screen.includes('\\u0003\\u001b[2J\\u009b2J'));
    assert.ok(!screen.includes('\x1b[2J'));
    assert.equal(sent.length, 2, 'Display must never send input back to backend');
    assert.equal(session.read().events.filter(e => e.type === 'output').length, 0);
    const bytes = Buffer.from('中文');
    session.output(bytes.subarray(0, 1)); session.output(bytes.subarray(1));
    assert.ok(screen.endsWith('中文'), 'Output decoder survives interleaved annotations');
    transcript.dispose();
    const before = screen;
    session.output('after dispose');
    assert.equal(screen, before);
    session.close();
  });
}
