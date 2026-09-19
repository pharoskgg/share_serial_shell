// node-pty 1.1.0 ships some POSIX spawn-helper binaries without execute bits.
// Repair at install/package time so VSIX users don't need a compiler or chmod.
const { existsSync, readdirSync, statSync, chmodSync } = require('node:fs');
const { dirname, join } = require('node:path');
if (process.platform !== 'win32') {
  const root = dirname(require.resolve('node-pty/package.json'));
  const prebuilds = join(root, 'prebuilds');
  const directories = [join(root, 'build', 'Release'), join(root, 'build', 'Debug')];
  if (existsSync(prebuilds)) directories.push(...readdirSync(prebuilds).map(dir => join(prebuilds, dir)));
  for (const directory of directories) {
    const helper = join(directory, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
  }
}
