const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = join(__dirname, '..', 'dist', 'test');
const tests = readdirSync(directory).filter(file => file.endsWith('.test.js')).map(file => join(directory, file));
if (!tests.length) throw new Error('No compiled tests found');
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
