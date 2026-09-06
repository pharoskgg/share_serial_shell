import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Automatic local connection hand-off; never print the token in logs. */
export async function publishConnection(root: string, url: string, token: string): Promise<string> {
  const ignorePath = join(root, '.gitignore');
  let ignore = '';
  try { ignore = await readFile(ignorePath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
  if (!ignore.split(/\r?\n/).some(line => ['/.shared-terminal/', '.shared-terminal/'].includes(line.trim()))) {
    await writeFile(ignorePath, ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '\n# Local shared terminal MCP credentials\n/.shared-terminal/\n');
  }
  const directory = join(root, '.shared-terminal');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({ servers: { 'shared-terminal': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2), { mode: 0o600 });
  return path;
}
