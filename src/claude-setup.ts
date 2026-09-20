import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { atomicWrite, prepareBridge } from './agent-setup';

type JsonObject = Record<string, unknown>;
export interface ClaudeRegistration {
  client: 'Claude CLI' | 'Claude Desktop';
  path: string;
  changed: boolean;
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Preserve all unrelated Claude state and refuse to replace an unmanaged name collision. */
export function updateClaudeConfig(original: string, desired: JsonObject, previous?: JsonObject): string {
  const parsed: unknown = original.trim() ? JSON.parse(original) : {};
  if (!object(parsed)) { throw new Error('Claude 配置根节点不是 JSON 对象，已保留原文件。'); }
  const servers = parsed.mcpServers === undefined ? {} : parsed.mcpServers;
  if (!object(servers)) { throw new Error('Claude 配置中的 mcpServers 不是对象，已保留原文件。'); }
  const existing = servers.shared_terminal;
  if (existing !== undefined && same(existing, desired)) { return original; }
  if (existing !== undefined && (!previous || !same(existing, previous))) {
    throw new Error('Claude 已有同名 shared_terminal 配置，未覆盖用户配置。');
  }
  parsed.mcpServers = { ...servers, shared_terminal: desired };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; } throw error; }
}

async function registerClaudeConfig(path: string, client: ClaudeRegistration['client'], storage: string,
  executable: string, modulePath: string): Promise<ClaudeRegistration> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const desired = await prepareBridge(storage, executable, modulePath);
  const key = createHash('sha256').update(path).digest('hex');
  const statePath = join(storage, `claude-${key}.managed.json`);
  const lock = `${path}.shared-terminal.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error(`${client} 配置正在被其他程序更新，请稍后重试。`);
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  try {
    const original = await readOptional(path);
    let previous: JsonObject | undefined;
    const saved = await readOptional(statePath);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (object(parsed)) { previous = parsed; }
    }
    const updated = updateClaudeConfig(original, desired, previous);
    if (updated !== original) {
      if (await readOptional(path) !== original) { throw new Error(`${client} 配置刚被其他程序修改，已保留修改，请重试。`); }
      await atomicWrite(path, updated);
    }
    await atomicWrite(statePath, JSON.stringify(desired));
    return { client, path, changed: updated !== original };
  } finally { await rmdir(lock); }
}

export function claudeDesktopConfigPath(home: string, platform = process.platform, appData = process.env.APPDATA): string | undefined {
  if (platform === 'darwin') { return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'); }
  if (platform === 'win32') { return join(appData || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'); }
  return undefined;
}

export async function registerClaudeClients(home: string, storage: string, executable: string, modulePath: string,
  platform = process.platform, appData = process.env.APPDATA): Promise<ClaudeRegistration[]> {
  const targets: Array<[ClaudeRegistration['client'], string]> = [['Claude CLI', join(home, '.claude.json')]];
  const desktop = claudeDesktopConfigPath(home, platform, appData);
  if (desktop) { targets.push(['Claude Desktop', desktop]); }
  const results: ClaudeRegistration[] = [];
  for (const [client, path] of targets) {
    results.push(await registerClaudeConfig(path, client, storage, executable, modulePath));
  }
  return results;
}
