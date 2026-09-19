import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { Server } from 'ssh2';
import { attachSerial, connectLocal, connectSsh, listSerialPorts } from '../backends';
import { SerialPortMock } from 'serialport';
import { Session } from '../session';

async function waitOutput(session: Session, expected: string, timeout = 10000): Promise<string> {
  const deadline = Date.now() + timeout;
  let cursor = 0;
  let output = '';
  while (Date.now() < deadline) {
    await session.waitForEntries(cursor, 200);
    const read = session.read(cursor);
    cursor = read.nextCursor;
    output += read.events.filter(event => event.type === 'output').map(event => event.data).join('');
    if (output.includes(expected)) { return output; }
    if (session.state === 'closed') { break; }
  }
  assert.fail(`Did not receive ${expected}; output=${JSON.stringify(output)}`);
}

test('native PTY launches an interactive shell and supports human then AI writes', { timeout: 20000 }, async () => {
  const session = new Session('local', 'local integration');
  try {
    await connectLocal(session, process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', homedir());
    await session.write(Buffer.from(process.platform === 'win32' ? "Write-Output ('SHARED_' + 'HUMAN_OK')\r" : "printf 'SHARED_%s\\n' HUMAN_OK\r"), 'human');
    await waitOutput(session, 'SHARED_HUMAN_OK');
    await session.write(Buffer.from(process.platform === 'win32' ? "Write-Output ('SHARED_' + 'AI_OK')\r" : "printf 'SHARED_%s\\n' AI_OK\r"), 'ai');
    await waitOutput(session, 'SHARED_AI_OK');
    session.resize(120, 40);
  } finally { session.close(); }
});

test('SSH performs host verification and exchanges data with a real local SSH server', { timeout: 20000 }, async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'secret' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const sshSession = accept();
      sshSession.on('pty', acceptPty => acceptPty?.());
      sshSession.on('window-change', acceptWindow => acceptWindow?.());
      sshSession.on('shell', acceptShell => {
        const stream = acceptShell();
        stream.write('SSH_READY\r\n');
        stream.on('data', (data: Buffer) => stream.write(Buffer.concat([Buffer.from('ECHO:'), data])));
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = new Session('ssh', 'ssh integration');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let verified = false;
    await connectSsh(session, { name: 'test', host: '127.0.0.1', port: address.port, username: 'test' }, { password: 'secret' }, async hash => { verified = /^[a-f0-9]{64}$/.test(hash); return verified; });
    assert.equal(verified, true);
    await waitOutput(session, 'SSH_READY');
    await session.write(Buffer.from('human\r'), 'human');
    await session.write(Buffer.from('ai\r'), 'ai');
    await waitOutput(session, 'ECHO:ai');
    session.resize(100, 30);
  } finally { session.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('serial native bindings load and enumerate devices', async () => {
  assert.ok(Array.isArray(await listSerialPorts()));
});

test('serial adapter preserves binary bytes and accepts both actors through a mock binding', async () => {
  const path = '/dev/SHARED_MOCK';
  SerialPortMock.binding.createPort(path, { echo: true, record: true });
  const port = new SerialPortMock({ path, baudRate: 115200, autoOpen: false });
  const session = new Session('serial', 'mock device');
  try {
    await attachSerial(session, port);
    await session.write(Buffer.from([0, 255, 13, 10]), 'ai');
    await session.write(Buffer.from('human'), 'human');
    assert.deepEqual(port.port?.recording, Buffer.from([0, 255, 13, 10, ...Buffer.from('human')]));
    await waitOutput(session, 'human');
    const received = Buffer.concat(session.read().events.filter(event => event.type === 'output').map(event => Buffer.from(event.base64!, 'base64')));
    assert.deepEqual(received, port.port?.recording);
  } finally { session.close(); }
});

test('serial driver write failures close the session and cancel queued input', async () => {
  const session = new Session('serial', 'failed device');
  let writes = 0, closed = false;
  await attachSerial(session, {
    get isOpen() { return !closed; }, on() {},
    open(callback) { callback(null); },
    write(_bytes, callback) { writes++; callback(new Error('driver failed')); },
    drain(callback) { callback(null); },
    close(callback) { closed = true; callback(null); },
  });
  await Promise.all([
    assert.rejects(session.write(Buffer.alloc(8), 'ai'), /driver failed/),
    assert.rejects(session.write(Buffer.alloc(4), 'human')),
  ]);
  assert.equal(session.state, 'closed');
  assert.equal(writes, 1);
  assert.equal(closed, true);
});
