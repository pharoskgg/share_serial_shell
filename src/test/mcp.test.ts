import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Sessions } from '../session';
import { startMcp, type Actions } from '../mcp';

test('real MCP HTTP client discovers, writes, reads, and closes a shared terminal', async () => {
  const sessions = new Sessions();
  const actions: Actions = {
    profiles: () => [], ports: async () => [], show() {},
    openLocal: async () => {
      const session = sessions.create('local', 'mock shell');
      session.attach({ write: data => session.output(data), close() {} });
      return session;
    },
    openSsh: async () => { throw new Error('No profiles'); },
    openSerial: async () => { throw new Error('No hardware'); },
  };
  const service = await startMcp(sessions, actions, 'test-token');
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(service.url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(service.url, { method: 'POST', headers: { Authorization: 'Bearer test-token', Origin: 'https://example.org' } })).status, 403);
    assert.equal((await fetch(service.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: 'Bearer test-token' } } }));
    const tools = (await client.listTools()).tools;
    assert.ok(JSON.stringify(tools).length < 5000, 'Keep the complete tool catalog compact');
    const names = tools.map(tool => tool.name);
    assert.equal(names.length, 4);
    assert.ok(names.includes('session'));
    assert.match(tools.find(tool => tool.name === 'list_sessions')?.description ?? '', /shared.*terminal.*call this first/i);
    assert.match(tools.find(tool => tool.name === 'write_session')?.description ?? '', /operating a shared terminal/i);
    assert.match(tools.find(tool => tool.name === 'read_session')?.description ?? '', /normally after write_session/i);
    const opened = await client.callTool({ name: 'session', arguments: { action: 'local' } });
    const info = JSON.parse((opened.content as { text: string }[])[0].text);
    const session = sessions.get(info.id);
    await session.write(Buffer.from('human\r'), 'human');
    const written = await client.callTool({ name: 'write_session', arguments: { sessionId: info.id, data: 'AI\r' } });
    assert.equal(written.isError, undefined);
    const read = await client.callTool({ name: 'read_session', arguments: { sessionId: info.id } });
    const events = JSON.parse((read.content as { text: string }[])[0].text).events;
    assert.ok(events.some((event: any) => event.actor === 'human' && event.data === 'human\r'));
    assert.ok(events.some((event: any) => event.actor === 'ai' && event.data === 'AI\r'));
    assert.ok(events.some((event: any) => event.type === 'output' && event.data === 'AI\r'));
    assert.ok(events.every((event: any) => event.base64 === undefined && event.time === undefined));
    const raw = await client.callTool({ name: 'read_session', arguments: { sessionId: info.id, format: 'raw' } });
    const rawEvents = JSON.parse((raw.content as { text: string }[])[0].text).events;
    assert.ok(rawEvents.some((event: any) => event.base64 === Buffer.from('AI\r').toString('base64')));
    const bad = await client.callTool({ name: 'write_session', arguments: { sessionId: info.id, data: '###', encoding: 'base64' } });
    assert.equal(bad.isError, true);
    await client.callTool({ name: 'session', arguments: { action: 'close', sessionId: info.id } });
    const closed = await client.callTool({ name: 'write_session', arguments: { sessionId: info.id, data: 'no' } });
    assert.equal(closed.isError, true);
  } finally { await client.close(); sessions.dispose(); await service.close(); }
});

test('MCP text and binary writes preserve the current UI for serial, SSH and local sessions', async () => {
  const sessions = new Sessions();
  const shown: string[] = [];
  const actions: Actions = {
    profiles: () => [], ports: async () => [], show: id => { shown.push(id); },
    openLocal: async () => { throw new Error('Use existing sessions'); },
    openSsh: async () => { throw new Error('Use existing sessions'); },
    openSerial: async () => { throw new Error('Use existing sessions'); },
  };
  const service = await startMcp(sessions, actions, 'view-regression-token');
  const client = new Client({ name: 'view-regression', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: 'Bearer view-regression-token' } } }));
    for (const kind of ['serial', 'ssh', 'local'] as const) {
      const session = sessions.create(kind, `${kind} already shown by human`);
      const received: Buffer[] = [];
      session.attach({ write: bytes => { received.push(bytes); session.output(bytes); }, close() {} });
      for (const input of [{ data: 'help\r', encoding: 'utf8' }, { data: 'AP8NCg==', encoding: 'base64' }]) {
        const result = await client.callTool({ name: 'write_session', arguments: { sessionId: session.id, ...input } });
        assert.ok(!result.isError);
      }
      await session.write(Buffer.from('human\r'), 'human');
      const read = await client.callTool({ name: 'read_session', arguments: { sessionId: session.id } });
      assert.ok(!read.isError);
      assert.deepEqual(received, [Buffer.from('help\r'), Buffer.from([0, 255, 13, 10]), Buffer.from('human\r')]);
      assert.equal(session.read().events.filter(event => event.actor === 'ai').length, 2, 'AI input audit remains available');
    }
    assert.deepEqual(shown, [], 'Reading and writing must never invoke UI presentation');
    const id = sessions.list()[0].id;
    await client.callTool({ name: 'session', arguments: { action: 'show', sessionId: id } });
    assert.deepEqual(shown, [id], 'Explicit show_session still works');
  } finally { await client.close(); sessions.dispose(); await service.close(); }
});
