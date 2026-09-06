import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as TOML from '@iarna/toml';
import { registerCodex, updateCodexConfig } from '../agent-setup';

test('Codex registration preserves comments, unrelated settings and credentials, and is idempotent', () => {
  const original = '# my settings\r\nmodel = "example"\r\n[mcp_servers.other]\r\nurl = "http://localhost:1234" # keep\r\n';
  const updated = updateCodexConfig(original, 'C:\\Program Files\\Code.exe', 'C:\\Users\\测试\\bridge.cjs');
  assert.ok(updated.startsWith(original));
  const server = (TOML.parse(updated).mcp_servers as any).shared_terminal;
  assert.equal(server.command, 'C:\\Program Files\\Code.exe');
  assert.deepEqual(server.args, ['C:\\Users\\测试\\bridge.cjs']);
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(updateCodexConfig(updated, server.command, server.args[0]), updated);
  const upgraded = updateCodexConfig(updated, 'D:\\Code.exe', 'D:\\bridge.cjs');
  assert.ok(upgraded.startsWith(original));
  assert.equal((TOML.parse(upgraded).mcp_servers as any).shared_terminal.command, 'D:\\Code.exe');
});

test('invalid TOML, unmanaged conflicts and malformed managed blocks cannot overwrite settings', () => {
  assert.throws(() => updateCodexConfig('model = [', 'node', 'bridge'));
  assert.throws(() => updateCodexConfig('[mcp_servers.shared_terminal]\ncommand="custom"', 'node', 'bridge'), /同名/);
  assert.throws(() => updateCodexConfig('# BEGIN shared-terminal-mcp (managed by VS Code extension)', 'node', 'bridge'), /不完整/);
  const modified = updateCodexConfig('', 'node', 'bridge').replace('# END shared-terminal-mcp', '[mcp_servers.other]\ncommand="custom"\n# END shared-terminal-mcp');
  assert.throws(() => updateCodexConfig(modified, 'node', 'bridge'), /其他设置/);
});

test('simultaneous VS Code windows register once and a launcher follows extension upgrades', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-terminal-agent-'));
  const home = join(root, 'codex');
  const storage = join(root, 'storage');
  const outcomes = await Promise.all([
    registerCodex(home, storage, process.execPath, '/extension/v1/bridge.js'),
    registerCodex(home, storage, process.execPath, '/extension/v1/bridge.js'),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  const before = await readFile(join(home, 'config.toml'), 'utf8');
  assert.equal(await registerCodex(home, storage, process.execPath, '/extension/v2/bridge.js'), false);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(storage, 'runtime.json'), 'utf8')).modulePath, '/extension/v2/bridge.js');
  await writeFile(join(home, 'config.toml'), 'model = [');
  await assert.rejects(registerCodex(home, storage, process.execPath, '/extension/v2/bridge.js'));
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model = [');
});
