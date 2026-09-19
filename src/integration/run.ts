import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as TOML from '@iarna/toml';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Invoked by a real VS Code extension host, not the Node unit test runner. */
export async function run(): Promise<void> {
  const results = join(__dirname, '../../.test-results');
  await mkdir(results, { recursive: true });
  const client = new Client({ name: 'vscode-integration', version: '1.0.0' });
  const agent = new Client({ name: 'codex-stdio-integration', version: '1.0.0' });
  try {
    const extension = vscode.extensions.getExtension('local-tools.shared-terminal-mcp');
    assert.ok(extension, 'Extension discovered');
    if (process.env.SHARED_TERMINAL_TEST_INSTALLED === '1') {
      assert.ok(extension.extensionPath.includes('installed-extensions'), 'Testing the installed VSIX, not the workspace source');
    }
    assert.equal(extension.packageJSON.contributes.views.sharedTerminal[0].name, '串口监视器');
    assert.equal(extension.packageJSON.contributes.commands.find((c: any) => c.command === 'sharedTerminal.enableAiConnection').title, '协作终端: 一键修复 AI 接入');
    await extension.activate();
    assert.ok(process.env.CODEX_HOME?.includes('.test-results'), 'Use isolated Codex configuration in integration tests');
    const codexConfig = TOML.parse(await readFile(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'));
    const registered = (codexConfig.mcp_servers as any).shared_terminal;
    assert.ok(registered, 'Activation registers Codex without a command or opt-in flag');
    await agent.connect(new StdioClientTransport({ command: registered.command, args: registered.args, env: { ...process.env, ...registered.env } as Record<string, string> }));
    assert.equal((await agent.listTools()).tools.length, 5, 'Generated configuration launches bridge with bundled VS Code runtime');
    if (process.env.SHARED_TERMINAL_CODEX_TEST_EXE) {
      const output = await promisify(execFile)(process.env.SHARED_TERMINAL_CODEX_TEST_EXE, ['mcp', 'list', '--json'], { env: process.env, windowsHide: true, timeout: 15000 });
      assert.ok(JSON.parse(output.stdout).some((server: any) => server.name === 'shared_terminal' && server.enabled), 'Real Codex CLI recognizes automatically registered server');
    }
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes('sharedTerminal.openLocal'));
    // This command now waits for the real bottom webview's ready message.
    assert.equal(await vscode.commands.executeCommand('sharedTerminal.openSerial'), true, 'Serial webview completed its ready handshake');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    assert.equal(await vscode.commands.executeCommand('sharedTerminal.openSerial'), true, 'Resolved serial view reopens without relying on its focus command');
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme === 'vscode-webview', false);
    await vscode.commands.executeCommand('sharedTerminal.sessions.focus');
    await vscode.commands.executeCommand('sharedTerminal.openLocal');
    const terminal = vscode.window.terminals.find(terminal => terminal.name.startsWith('协作 · '));
    assert.ok(terminal, 'Native panel terminal created');
    const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const config = JSON.parse(await readFile(join(workspace, '.shared-terminal', 'mcp.json'), 'utf8')).servers['shared-terminal'];
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
    const sessions = JSON.parse((listed.content as { text: string }[])[0].text);
    assert.equal(sessions.length, 1);
    const id = sessions[0].id;
    const bridgeResponse = await agent.callTool({ name: 'list_sessions', arguments: {} });
    const bridged = JSON.parse((bridgeResponse.content as { text: string }[])[0].text);
    assert.ok(bridged.some((session: any) => session.id === id && session.windowId), 'Bridge shares actual native terminal session');
    terminal.sendText(process.platform === 'win32' ? "Write-Output ('HOST_' + 'HUMAN_OK')" : "printf 'HOST_%s\\n' HUMAN_OK", true);
    const write = await agent.callTool({ name: 'write_session', arguments: { sessionId: id, data: process.platform === 'win32' ? "Write-Output ('HOST_' + 'AI_OK')\r" : "printf 'HOST_%s\\n' AI_OK\r" } });
    assert.ok(!write.isError, JSON.stringify(write));
    let cursor = 0;
    let output = '';
    let humanInput = false;
    let aiInput = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await client.callTool({ name: 'read_session', arguments: { sessionId: id, after: cursor, waitMs: 500 } });
      const read = JSON.parse((result.content as { text: string }[])[0].text);
      cursor = read.nextCursor;
      for (const event of read.events) {
        if (event.type === 'output') { output += event.data; }
        if (event.actor === 'human') { humanInput = true; }
        if (event.actor === 'ai') { aiInput = true; }
      }
      if (output.includes('HOST_HUMAN_OK') && output.includes('HOST_AI_OK') && humanInput && aiInput) { break; }
    }
    assert.ok(humanInput && aiInput, 'Both input sources recorded');
    assert.ok(output.includes('HOST_HUMAN_OK') && output.includes('HOST_AI_OK'), `Actual shell executed both inputs: ${JSON.stringify(output)}`);
    const ports = await client.callTool({ name: 'session', arguments: { action: 'ports' } });
    assert.ok(!ports.isError, 'Serial native addon loads inside Electron extension host');
    await vscode.commands.executeCommand('sharedTerminal.audit');
    await client.callTool({ name: 'session', arguments: { action: 'close', sessionId: id } });
    terminal.dispose();
    await writeFile(join(results, 'vscode-integration.json'), JSON.stringify({ passed: true, version: extension.packageJSON.version, extensionPath: extension.extensionPath, checks: ['automatic registration without opt-in', 'bundled Code.exe stdio runtime', 'real Codex CLI config loading', 'bridge/native terminal same session', 'Chinese labels', 'serial bottom webview ready', 'reopen hidden serial panel', 'human sendText', 'AI input through bridge', 'shell execution', 'serial native addon', 'audit command', 'close'] }, null, 2));
  } catch (error) {
    await writeFile(join(results, 'vscode-integration.json'), JSON.stringify({ passed: false, error: String(error), stack: (error as Error).stack }, null, 2));
    throw error;
  } finally { await agent.close(); await client.close(); }
}
