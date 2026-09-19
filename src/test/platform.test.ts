import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultShell, workspacePaths } from '../platform';

test('Windows ignores inherited POSIX shell, macOS/Linux/WSL honor the login shell', () => {
  assert.equal(defaultShell('win32', { SHELL: '/bin/bash' }), 'powershell.exe');
  assert.equal(defaultShell('darwin', { SHELL: '/bin/zsh' }), '/bin/zsh');
  assert.equal(defaultShell('linux', { SHELL: '/bin/bash', WSL_DISTRO_NAME: 'Ubuntu' }), '/bin/bash');
});

test('WSL/remote workspace paths belong only to the remote extension host', () => {
  const folders = [{ scheme: 'file', fsPath: 'C:\\work' }, { scheme: 'vscode-remote', fsPath: '/home/user/project' }];
  assert.deepEqual(workspacePaths(folders, false), ['C:\\work']);
  assert.deepEqual(workspacePaths(folders, true), ['/home/user/project']);
});
