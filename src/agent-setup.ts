import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as TOML from '@iarna/toml';

const begin = '# BEGIN shared-terminal-mcp (managed by VS Code extension)';
const end = '# END shared-terminal-mcp';
export const serverName = 'shared_terminal';

export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Keep the rest of the user's TOML byte-for-byte, including comments. */
export function updateCodexConfig(original: string, executable: string, launcher: string): string {
  const parsed = TOML.parse(original);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const block = [begin, `[mcp_servers.${serverName}]`, `command = ${JSON.stringify(executable)}`,
    `args = [${JSON.stringify(launcher)}]`, 'startup_timeout_sec = 20', 'tool_timeout_sec = 45',
    `[mcp_servers.${serverName}.env]`, 'ELECTRON_RUN_AS_NODE = "1"', end, ''].join(newline);
  const start = original.indexOf(begin);
  let updated: string;
  if (start >= 0) {
    const finish = original.indexOf(end, start);
    if (finish < 0) { throw new Error('Codex 自动接入配置块不完整，已保留原文件。'); }
    const managed = TOML.parse(original.slice(start, finish));
    if (Object.keys(managed).some(key => key !== 'mcp_servers') ||
        Object.keys((managed.mcp_servers ?? {}) as object).some(key => key !== serverName)) {
      throw new Error('自动接入配置块包含其他设置，已保留原文件。');
    }
    const tail = original.slice(finish + end.length).replace(/^\r?\n/, '');
    updated = original.slice(0, start) + block + tail;
  } else {
    if ((parsed.mcp_servers as Record<string, unknown> | undefined)?.[serverName]) {
      throw new Error('Codex 已有同名 shared_terminal 配置，未覆盖用户配置。');
    }
    updated = original + (original && !original.endsWith('\n') ? newline : '') + newline + block;
  }
  TOML.parse(updated);
  return updated;
}

export async function registerCodex(codexHome: string, storage: string, executable: string, modulePath: string): Promise<boolean> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(storage, { recursive: true, mode: 0o700 });
  // The launcher path survives extension upgrades. The running bridge discovers
  // each window afresh, so changing HTTP ports doesn't change Codex configuration.
  await atomicWrite(join(storage, 'runtime.json'), JSON.stringify({ modulePath }));
  const launcher = join(storage, 'bridge.cjs');
  await atomicWrite(launcher, "const fs = require('node:fs'); const path = require('node:path');\n" +
    "Promise.resolve().then(() => require(JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime.json'), 'utf8')).modulePath).runBridge(path.join(__dirname, 'windows'))).catch(() => { console.error('Shared terminal bridge could not start. Use the extension repair button.'); process.exitCode = 1; });\n");
  const path = join(codexHome, 'config.toml');
  const lock = join(codexHome, '.shared-terminal-config.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) { throw new Error('Codex 配置正在被其他窗口更新，请点击自动修复重试。'); }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  try {
    let original = '';
    try { original = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    const updated = updateCodexConfig(original, executable, launcher);
    if (updated === original) { return false; }
    // Recheck immediately before replacing, so a concurrent external editor isn't
    // silently overwritten. Other plugin windows serialize on the lock above.
    let current = '';
    try { current = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    if (current !== original) { throw new Error('Codex 配置刚被其他程序修改，已保留修改，请点击自动修复重试。'); }
    await atomicWrite(path, updated);
    return true;
  } finally { const { rmdir } = await import('node:fs/promises'); await rmdir(lock); }
}

export interface WindowEndpoint {
  id: string;
  label: string;
  roots: string[];
  url: string;
  token: string;
  expiresAt: number;
}

export async function publishWindow(directory: string, endpoint: WindowEndpoint): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(join(directory, `${endpoint.id}.json`), JSON.stringify(endpoint));
}
