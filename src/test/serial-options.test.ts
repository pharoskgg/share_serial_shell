import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { serialInput, serialSchema } from '../serial-options';

test('monitor sends exact text / HEX bytes with configured endings', () => {
  assert.deepEqual(serialInput('help', 'utf8', 'crlf'), Buffer.from('help\r\n'));
  assert.deepEqual(serialInput('00 FF 0D 0A', 'hex', 'none'), Buffer.from([0, 255, 13, 10]));
  assert.deepEqual(serialInput('你好', 'utf8', 'cr'), Buffer.from('你好\r'));
  assert.throws(() => serialInput('F', 'hex', 'none'), /HEX/);
  assert.throws(() => serialInput('GG', 'hex', 'none'), /HEX/);
  assert.throws(() => serialInput('a'.repeat(16384), 'utf8', 'lf'), /16 KiB/);
});

test('UI and MCP share validated serial settings', () => {
  assert.deepEqual(z.object(serialSchema).parse({ path: ' COM3 ' }), { path: 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false });
  assert.equal(z.object(serialSchema).safeParse({ path: '', baudRate: 0 }).success, false);
  assert.equal(z.object(serialSchema).safeParse({ path: 'COM3', parity: 'bogus' }).success, false);
});
