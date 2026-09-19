import { userInfo } from 'node:os';

export function defaultShell(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') { return 'powershell.exe'; }
  if (env.SHELL) { return env.SHELL; }
  try { const shell = userInfo().shell; if (shell) { return shell; } } catch { /* Minimal containers may lack passwd. */ }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

/** Remote URIs are host-local paths only when this extension runs remotely. */
export function workspacePaths(folders: readonly { scheme: string; fsPath: string }[], remoteHost: boolean): string[] {
  return folders.filter(uri => remoteHost ? uri.scheme === 'vscode-remote' : uri.scheme === 'file').map(uri => uri.fsPath);
}
