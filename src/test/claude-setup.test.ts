import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeDesktopConfigPath, registerClaudeClients, updateClaudeConfig } from '../claude-setup';

const bridge = { command: '/Applications/Code', args: ['/stable/bridge.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };

test('Claude JSON registration preserves unrelated state and refuses unmanaged conflicts', () => {
  const original = JSON.stringify({ oauthAccount: { email: 'user@example.com' }, mcpServers: { other: { command: 'other' } } });
  const updated = updateClaudeConfig(original, bridge);
  const parsed = JSON.parse(updated);
  assert.deepEqual(parsed.oauthAccount, { email: 'user@example.com' });
  assert.deepEqual(parsed.mcpServers.other, { command: 'other' });
  assert.deepEqual(parsed.mcpServers.shared_terminal, bridge);
  assert.equal(updateClaudeConfig(updated, bridge, bridge), updated);
  assert.throws(() => updateClaudeConfig(JSON.stringify({ mcpServers: { shared_terminal: { command: 'custom' } } }), bridge), /同名/);
  assert.throws(() => updateClaudeConfig('[]', bridge), /根节点/);
  assert.throws(() => updateClaudeConfig('{"mcpServers":[]}', bridge), /mcpServers/);
});

test('Claude CLI and Desktop registration is idempotent and upgrades only managed entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-terminal-claude-'));
  const storage = join(root, 'storage');
  const first = await registerClaudeClients(root, storage, process.execPath, '/extension/v1/bridge.js', 'darwin');
  assert.equal(first.length, 2);
  assert.ok(first.every(result => result.changed));
  const cliPath = join(root, '.claude.json');
  const desktopPath = claudeDesktopConfigPath(root, 'darwin')!;
  const cli = JSON.parse(await readFile(cliPath, 'utf8'));
  const desktop = JSON.parse(await readFile(desktopPath, 'utf8'));
  assert.deepEqual(cli.mcpServers.shared_terminal, desktop.mcpServers.shared_terminal);
  assert.equal(cli.mcpServers.shared_terminal.command, process.execPath);
  assert.deepEqual((await registerClaudeClients(root, storage, process.execPath, '/extension/v2/bridge.js', 'darwin')).map(result => result.changed), [false, false]);
  assert.equal(JSON.parse(await readFile(join(storage, 'runtime.json'), 'utf8')).modulePath, '/extension/v2/bridge.js');
  cli.mcpServers.shared_terminal = { command: 'user-owned' };
  await writeFile(cliPath, JSON.stringify(cli));
  await assert.rejects(registerClaudeClients(root, storage, process.execPath, '/extension/v3/bridge.js', 'darwin'), /同名/);
  assert.equal(JSON.parse(await readFile(cliPath, 'utf8')).mcpServers.shared_terminal.command, 'user-owned');
});

test('Claude Desktop path is available only on supported desktop platforms', () => {
  assert.equal(claudeDesktopConfigPath('/home/me', 'linux'), undefined);
  assert.equal(claudeDesktopConfigPath('C:\\Users\\me', 'win32', 'C:\\Users\\me\\AppData\\Roaming'),
    join('C:\\Users\\me\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
});
