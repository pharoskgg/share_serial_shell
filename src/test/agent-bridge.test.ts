import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Sessions } from '../session';
import { startMcp, type Actions } from '../mcp';
import { WindowRouter } from '../agent-bridge';
import { publishWindow, registerCodex, type WindowEndpoint } from '../agent-setup';

const decode = (response: any) => JSON.parse(response.content[0].text);
function mock() {
  const sessions = new Sessions();
  let writes = 0;
  const actions: Actions = {
    profiles: () => [{ name: 'board', host: 'example', username: 'user' }], ports: async () => [], show() {},
    openLocal: async () => {
      const session = sessions.create('local', 'test terminal');
      session.attach({ write: data => { writes++; session.output(data); }, close() {} });
      return session;
    }, openSsh: async () => { throw new Error('No SSH'); }, openSerial: async () => { throw new Error('No serial'); },
  };
  return { sessions, actions, writes: () => writes };
}

test('bridge routes exact session IDs across windows, refuses ambiguous opens, and follows new ports and tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-terminal-routing-'));
  const first = mock(), second = mock();
  const service1 = await startMcp(first.sessions, first.actions, 'one');
  const service2 = await startMcp(second.sessions, second.actions, 'two');
  let replacement: Awaited<ReturnType<typeof startMcp>> | undefined;
  try {
    const endpoint1: WindowEndpoint = { id: randomUUID(), label: 'one', roots: [join(directory, 'one')], url: service1.url, token: 'one', expiresAt: Date.now() + 90000 };
    const endpoint2: WindowEndpoint = { id: randomUUID(), label: 'two', roots: [join(directory, 'two')], url: service2.url, token: 'two', expiresAt: Date.now() + 90000 };
    await publishWindow(directory, endpoint1); await publishWindow(directory, endpoint2);
    const router = new WindowRouter(directory, directory);
    await assert.rejects(router.invoke('open_local_terminal', {}), /多个/);
    const session = decode(await router.invoke('open_local_terminal', { windowId: endpoint2.id }));
    await router.invoke('write_session', { sessionId: session.id, data: 'test\r' });
    assert.equal(first.writes(), 0); assert.equal(second.writes(), 1);
    assert.equal(decode(await router.invoke('list_sessions', {}))[0].windowId, endpoint2.id);
    await assert.rejects(router.invoke('write_session', { sessionId: session.id, windowId: endpoint1.id, data: 'wrong' }), /找不到/);
    const matched = new WindowRouter(directory, join(directory, 'one', 'src'));
    await matched.invoke('open_local_terminal', {});
    assert.equal(first.sessions.list().length, 1);
    await service2.close();
    replacement = await startMcp(second.sessions, second.actions, 'rotated-token');
    await publishWindow(directory, { ...endpoint2, url: replacement.url, token: 'rotated-token' });
    await router.invoke('write_session', { sessionId: session.id, data: 'after restart\r' });
    assert.equal(second.writes(), 2);
    const data = decode(await router.invoke('read_session', { sessionId: session.id }));
    assert.ok(data.events.some((event: any) => event.data === 'after restart\r'));
    await publishWindow(directory, { ...endpoint1, expiresAt: Date.now() - 1 });
    assert.equal((await router.endpoints()).length, 1);
    await publishWindow(directory, { ...endpoint2, url: 'https://example.com/mcp' });
    assert.equal((await router.endpoints()).length, 0);
  } finally { first.sessions.dispose(); second.sessions.dispose(); await service1.close(); await service2.close(); await replacement?.close(); }
});

test('real stdio bridge starts without VS Code, discovers a later window and exposes tools through generated Codex config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-terminal-stdio-'));
  await registerCodex(join(directory, 'codex'), directory, process.execPath, join(__dirname, '..', 'agent-bridge.js'));
  const client = new Client({ name: 'agent-bridge-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(directory, 'bridge.cjs')], stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', data => { errors += data.toString(); });
  const backend = mock();
  const service = await startMcp(backend.sessions, backend.actions, 'stdio-token');
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    assert.ok(tools.some(tool => tool.name === 'write_session'));
    assert.deepEqual(decode(await client.callTool({ name: 'list_windows', arguments: {} })), []);
    const absent = await client.callTool({ name: 'list_sessions', arguments: {} });
    assert.equal(absent.isError, true);
    const id = randomUUID();
    await publishWindow(join(directory, 'windows'), { id, label: 'later window', roots: [], url: service.url, token: 'stdio-token', expiresAt: Date.now() + 90000 });
    const opened = decode(await client.callTool({ name: 'open_local_terminal', arguments: {} }));
    const write = await client.callTool({ name: 'write_session', arguments: { sessionId: opened.id, data: 'from stdio\r' } });
    assert.ok(!write.isError);
    assert.equal(backend.writes(), 1);
    await unlink(join(directory, 'windows', `${id}.json`));
    assert.deepEqual(decode(await client.callTool({ name: 'list_windows', arguments: {} })), []);
    assert.equal(errors, '');
  } finally { await client.close(); backend.sessions.dispose(); await service.close(); }
});
