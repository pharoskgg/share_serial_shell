import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealSerialView, SerialViewUnavailableError } from '../reveal-view';

test('resolved serial views reopen through their API without a generated focus command', async () => {
  await revealSerialView({ showResolvedView: () => true, commands: async () => { throw new Error('Should not enumerate commands'); }, execute: async () => { throw new Error('Should not execute commands'); } });
});

test('missing serial focus command falls back to the existing panel container', async () => {
  const executed: string[] = [];
  await revealSerialView({ showResolvedView: () => false, commands: async () => ['workbench.view.extension.sharedTerminal'], execute: async command => { executed.push(command); } });
  assert.deepEqual(executed, ['workbench.view.extension.sharedTerminal']);
});

test('a focus command removed during extension update also falls back', async () => {
  const executed: string[] = [];
  await revealSerialView({ showResolvedView: () => false, commands: async () => ['sharedTerminal.serial.focus', 'workbench.view.extension.sharedTerminal'], execute: async command => {
    executed.push(command);
    if (command === 'sharedTerminal.serial.focus') { throw new Error("command 'sharedTerminal.serial.focus' not found"); }
  } });
  assert.deepEqual(executed, ['sharedTerminal.serial.focus', 'workbench.view.extension.sharedTerminal']);
});

test('missing manifest contributions give a reload recovery error', async () => {
  await assert.rejects(revealSerialView({ showResolvedView: () => false, commands: async () => [], execute: async () => {} }), SerialViewUnavailableError);
});
