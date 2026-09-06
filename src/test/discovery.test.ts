import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishConnection } from '../discovery';

test('automatic connection hand-off preserves gitignore and refreshes credentials after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-terminal-discovery-'));
  try {
    await writeFile(join(root, '.gitignore'), 'node_modules/');
    const path = await publishConnection(root, 'http://127.0.0.1:1234/mcp', 'first-token');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).servers['shared-terminal'].headers.Authorization, 'Bearer first-token');
    await publishConnection(root, 'http://127.0.0.1:5678/mcp', 'new-token');
    const updated = JSON.parse(await readFile(path, 'utf8')).servers['shared-terminal'];
    assert.equal(updated.url, 'http://127.0.0.1:5678/mcp');
    assert.equal(updated.headers.Authorization, 'Bearer new-token');
    const ignored = await readFile(join(root, '.gitignore'), 'utf8');
    assert.ok(ignored.startsWith('node_modules/\n'));
    assert.equal(ignored.split('/.shared-terminal/').length, 2);
  } finally {
    await unlink(join(root, '.shared-terminal', 'mcp.json')).catch(() => {});
    await rmdir(join(root, '.shared-terminal')).catch(() => {});
    await unlink(join(root, '.gitignore')).catch(() => {});
    await rmdir(root);
  }
});
