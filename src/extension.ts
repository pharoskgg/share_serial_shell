import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { connectLocal, connectSerial, connectSsh, listSerialPorts, type SerialOptions, type SshProfile } from './backends';
import { startMcp, type Actions } from './mcp';
import { Sessions, Session, type Entry } from './session';
import { publishConnection } from './discovery';
import { registerCodex, publishWindow, type WindowEndpoint } from './agent-setup';
import { SerialView } from './serial-view';
import { SerialViewUnavailableError } from './reveal-view';

let shutdown: (() => Promise<void>) | undefined;

class TerminalBridge implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  private ready = false;
  private pending = '';
  private dimensions?: vscode.TerminalDimensions;
  private readonly decoder = new StringDecoder('utf8');
  private readonly data = (chunk: Buffer) => this.display(this.decoder.write(chunk));
  private readonly entry = (entry: Entry) => {
    if (entry.type === 'status') { this.display(`\r\n\x1b[90m[协作终端] ${entry.data.replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m\r\n`); }
  };
  private readonly ended = () => { this.display(this.decoder.end()); };
  constructor(readonly session: Session) {
    session.on('data', this.data);
    session.on('entry', this.entry);
    session.on('closed', this.ended);
  }
  private display(text: string): void {
    if (this.ready) { this.writer.fire(text); }
    else { this.pending = (this.pending + text).slice(-1024 * 1024); }
  }
  open(dimensions?: vscode.TerminalDimensions): void {
    this.ready = true;
    this.writer.fire('\x1b[90m人和 AI 共享输入 · AI 的原始输入可在“协作终端 · AI 输入记录”中查看\x1b[0m\r\n' + this.pending);
    this.pending = '';
    if (dimensions) { this.setDimensions(dimensions); }
  }
  close(): void { this.session.close('Terminal closed by user'); this.dispose(); }
  handleInput(data: string): void {
    // Large human pastes are split only to honor the per-write bound, with no actor lock.
    const characters = Array.from(data);
    void (async () => {
      for (let offset = 0; offset < characters.length; offset += 2048) {
        await this.session.write(Buffer.from(characters.slice(offset, offset + 2048).join('')), 'human');
      }
    })().catch(error => this.display(`\r\n[输入失败] ${String(error)}\r\n`));
  }
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    try { this.session.resize(dimensions.columns, dimensions.rows); } catch { /* Terminal may have exited. */ }
  }
  applyDimensions(): void { if (this.dimensions) { this.setDimensions(this.dimensions); } }
  dispose(): void {
    this.session.off('data', this.data);
    this.session.off('entry', this.entry);
    this.session.off('closed', this.ended);
    this.writer.dispose(); this.closer.dispose();
  }
}

class SessionTree implements vscode.TreeDataProvider<Session> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly refresh = () => this.changed.fire();
  constructor(private readonly sessions: Sessions) { sessions.on('change', this.refresh); }
  getChildren(): Session[] { return this.sessions.list(); }
  getTreeItem(session: Session): vscode.TreeItem {
    const item = new vscode.TreeItem(session.name);
    const states = { connecting: '连接中', open: '共同输入', closed: '已关闭' };
    item.description = `${session.kind} · ${states[session.state]}`;
    item.tooltip = `${session.id}\n你和 AI 可以同时输入，不会互相暂停。`;
    item.iconPath = new vscode.ThemeIcon(session.kind === 'serial' ? 'plug' : session.kind === 'ssh' ? 'remote' : 'terminal');
    item.contextValue = 'session';
    item.command = { command: 'sharedTerminal.show', title: '显示会话', arguments: [session] };
    return item;
  }
  dispose(): void { this.sessions.off('change', this.refresh); this.changed.dispose(); }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) { return; }
  const sessions = new Sessions();
  const terminals = new Map<string, vscode.Terminal>();
  let serialView: SerialView;
  const audit = vscode.window.createOutputChannel('协作终端 · AI 输入记录');
  const serviceLog = vscode.window.createOutputChannel('协作终端 · 服务');
  const tree = new SessionTree(sessions);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(terminal) 协作 MCP';
  status.command = 'sharedTerminal.enableAiConnection';
  context.subscriptions.push(audit, serviceLog, tree, status, sessions, vscode.window.registerTreeDataProvider('sharedTerminal.sessions', tree));

  const config = () => vscode.workspace.getConfiguration('sharedTerminal');
  const profiles = () => config().get<SshProfile[]>('sshProfiles', []);
  const secretKey = (profile: SshProfile) => `ssh:${JSON.stringify([profile.host, profile.port ?? 22, profile.username])}`;

  sessions.on('created', (session: Session) => {
    const bridge = new TerminalBridge(session);
    const terminal = vscode.window.createTerminal({ name: `协作 · ${session.name}`, pty: bridge, location: vscode.TerminalLocation.Panel, isTransient: true });
    terminals.set(session.id, terminal);
    context.subscriptions.push(terminal, bridge);
    if (session.kind !== 'serial') { terminal.show(true); }
    session.on('change', () => {
      if (session.state === 'open') {
        bridge.applyDimensions();
      }
    });
  });
  sessions.on('entry', (session: Session, entry: Entry) => {
    if (entry.type === 'input' && entry.actor === 'ai') {
      audit.appendLine(`${entry.time} [${session.name.replace(/[\r\n]/g, ' ')} / ${session.id}] AI SEND ${JSON.stringify(entry.data)} base64=${entry.base64}`);
    } else if (entry.type === 'status') {
      serviceLog.appendLine(`${entry.time} [${session.id}] ${JSON.stringify(entry.data)}`);
    }
  });
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    for (const [id, saved] of terminals) { if (saved === terminal) { sessions.get(id).close(); terminals.delete(id); break; } }
  }));

  const connect = async (session: Session, run: () => Promise<void>) => {
    try { await run(); return session; }
    catch (error) { session.close(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const actions: Actions = {
    profiles: () => profiles().map(({ name, host, port, username }) => ({ name, host, port, username })),
    ports: listSerialPorts,
    openLocal: async (name = '本地 Shell') => {
      const shell = config().get<string>('shell') || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
      const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
      const session = sessions.create('local', name);
      return connect(session, () => connectLocal(session, shell, workspace?.uri.fsPath ?? homedir()));
    },
    openSsh: async name => {
      const profile = profiles().find(profile => profile.name === name);
      if (!profile) { throw new Error(`找不到 SSH 配置 ${name}，请先运行“协作终端: 添加 SSH 配置”。`); }
      const credentials = JSON.parse(await context.secrets.get(secretKey(profile)) || '{}') as { password?: string; passphrase?: string };
      const session = sessions.create('ssh', `${profile.name} (${profile.username}@${profile.host})`);
      return connect(session, () => connectSsh(session, profile, credentials, async hash => {
        const hostKey = `host:${JSON.stringify([profile.host, profile.port ?? 22])}`;
        const saved = context.globalState.get<string>(hostKey);
        if (saved === hash) { return true; }
        if (saved) { void vscode.window.showErrorMessage(`SSH ${profile.host} 的主机指纹已变更，已拒绝连接。请核实服务器后使用新的配置主机名。`); return false; }
        const answer = await vscode.window.showWarningMessage(`首次连接 SSH ${profile.host}:${profile.port ?? 22}\nSHA256(hex): ${hash}`, { modal: true }, '信任并连接');
        if (answer !== '信任并连接') { return false; }
        await context.globalState.update(hostKey, hash);
        return true;
      }));
    },
    openSerial: async options => {
      if (sessions.list().some(s => s.kind === 'serial' && s.state !== 'closed' && s.name.startsWith(`${options.path} @ `))) { throw new Error('该串口已经在一个共享会话中打开，请使用已有会话。'); }
      const session = sessions.create('serial', `${options.path} @ ${options.baudRate}`);
      const opened = await connect(session, () => connectSerial(session, options));
      await serialView.reveal(opened);
      return opened;
    },
    show: id => {
      const session = sessions.get(id);
      if (session.kind === 'serial') { void serialView.reveal(session).catch(error => serviceLog.appendLine(String(error))); }
      else { terminals.get(id)?.show(true); }
    },
  };
  serialView = new SerialView(context, sessions, actions.openSerial, id => terminals.get(id)?.show(false));
  context.subscriptions.push(serialView, vscode.window.registerWebviewViewProvider('sharedTerminal.serial', serialView, { webviewOptions: { retainContextWhenHidden: true } }));

  const register = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`sharedTerminal.${name}`, async (...args: any[]) => {
    try { return await handler(...args); }
    catch (error) {
      if (error instanceof SerialViewUnavailableError) {
        void vscode.window.showErrorMessage(`协作终端: ${error.message}`, '重新加载窗口').then(action => {
          if (action === '重新加载窗口') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
        });
      } else { void vscode.window.showErrorMessage(`协作终端: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
  const choose = async (session?: Session): Promise<Session | undefined> => {
    if (session instanceof Session) { return session; }
    const active = vscode.window.activeTerminal;
    for (const [id, terminal] of terminals) { if (terminal === active) { return sessions.get(id); } }
    const picked = await vscode.window.showQuickPick(sessions.list().map(session => ({ label: session.name, description: session.state, session })), { placeHolder: '选择会话' });
    return picked?.session;
  };
  register('openLocal', () => actions.openLocal());
  register('show', async session => { const selected = await choose(session); if (selected?.kind === 'serial') { await serialView.reveal(selected); } else if (selected) { terminals.get(selected.id)?.show(false); } });
  register('close', async session => { const selected = await choose(session); if (selected) { selected.close(); terminals.get(selected.id)?.dispose(); } });
  register('audit', () => audit.show(true));
  register('addSsh', async () => {
    const name = await vscode.window.showInputBox({ title: 'SSH 配置名称', ignoreFocusOut: true, validateInput: value => !value.trim() ? '名称不能为空' : profiles().some(p => p.name === value.trim()) ? '名称已存在' : undefined });
    if (!name) { return; }
    const host = await vscode.window.showInputBox({ title: 'SSH 主机', prompt: '例如 192.168.1.10', ignoreFocusOut: true });
    if (!host?.trim()) { return; }
    const port = await vscode.window.showInputBox({ title: 'SSH 端口', value: '22', validateInput: value => /^\d+$/.test(value) && +value > 0 && +value < 65536 ? undefined : '请输入 1–65535' });
    if (!port) { return; }
    const username = await vscode.window.showInputBox({ title: 'SSH 用户名', ignoreFocusOut: true });
    if (!username?.trim()) { return; }
    const method = await vscode.window.showQuickPick(['密码', '私钥文件', 'SSH Agent'], { title: 'SSH 认证方式' });
    if (!method) { return; }
    const profile: SshProfile = { name: name.trim(), host: host.trim(), port: +port, username: username.trim() };
    let credentials: { password?: string; passphrase?: string } = {};
    if (method === '密码') {
      const password = await vscode.window.showInputBox({ title: 'SSH 密码（保存到系统密钥库）', password: true, ignoreFocusOut: true });
      if (password === undefined) { return; }
      credentials = { password };
    } else if (method === '私钥文件') {
      const files = await vscode.window.showOpenDialog({ title: '选择 SSH 私钥', canSelectMany: false });
      if (!files?.[0]) { return; }
      profile.privateKeyPath = files[0].fsPath;
      const passphrase = await vscode.window.showInputBox({ title: '私钥口令（无口令可留空）', password: true, ignoreFocusOut: true });
      if (passphrase === undefined) { return; }
      if (passphrase) { credentials.passphrase = passphrase; }
    } else {
      const agent = await vscode.window.showInputBox({ title: 'SSH Agent socket / named pipe', value: process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : '') });
      if (!agent) { return; }
      profile.agent = agent;
    }
    await context.secrets.store(secretKey(profile), JSON.stringify(credentials));
    await config().update('sshProfiles', [...profiles(), profile], vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`SSH 配置 ${profile.name} 已保存。`);
  });
  register('openSsh', async () => {
    if (!profiles().length) { await vscode.commands.executeCommand('sharedTerminal.addSsh'); }
    const picked = await vscode.window.showQuickPick(profiles().map(profile => ({ label: profile.name, description: `${profile.username}@${profile.host}:${profile.port ?? 22}` })), { title: '连接 SSH' });
    if (picked) { await actions.openSsh(picked.label); }
  });
  register('openSerial', async () => {
    await serialView.reveal();
    return true;
  });

  const token = await context.secrets.get('mcpToken') || randomBytes(32).toString('hex');
  await context.secrets.store('mcpToken', token);
  try {
    let lastActivity: Date | undefined;
    let setupError: string | undefined;
    let registered = false;
    const renderStatus = () => {
      status.text = setupError ? '$(warning) 协作 MCP · 接入需修复' : lastActivity ? '$(link) 协作 MCP · AI 已访问' : registered ? '$(link) 协作 MCP · 等待 AI' : '$(sync~spin) 协作 MCP · 自动接入中';
      status.tooltip = setupError ? `${setupError}\n点击一键修复，无需填写配置。` :
        (lastActivity ? `最近收到 Agent 请求：${lastActivity.toLocaleTimeString()}。` : '服务已启动，正在等待 Agent 调用。') +
        '\nVS Code 和本机 Codex 自动接入，无需复制地址或令牌。\n首次接入时，已经运行的 Codex 可能需要重启客户端才能加载工具。\n点击检查并修复接入。';
    };
    const service = await startMcp(sessions, actions, token, config().get<number>('mcpPort', 0), () => { lastActivity = new Date(); renderStatus(); });
    const storage = context.globalStorageUri.fsPath;
    const directory = join(storage, 'windows');
    const windowId = randomUUID();
    let stopped = false;
    let pending: Promise<void> = Promise.resolve();
    const roots = () => vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) ?? [];
    const heartbeat = () => {
      pending = pending.catch(() => {}).then(async () => {
        if (stopped) { return; }
        const endpoint: WindowEndpoint = { id: windowId, label: vscode.workspace.name ?? '未打开文件夹的窗口', roots: roots(), url: service.url, token, expiresAt: Date.now() + 90000 };
        await publishWindow(directory, endpoint);
      });
      return pending;
    };
    const timer = setInterval(() => { void heartbeat().catch(error => serviceLog.appendLine(`窗口发布失败：${String(error)}`)); }, 20000);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      stopped = true; clearInterval(timer);
      await pending.catch(() => {});
      await unlink(join(directory, `${windowId}.json`)).catch(() => {});
      sessions.dispose(); await service.close();
    })();
    shutdown = close;
    context.subscriptions.push({ dispose: () => { void close(); } });
    renderStatus();
    serviceLog.appendLine(`MCP listening at ${service.url}`);
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('sharedTerminal.mcp', {
      provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition('协作终端 MCP', vscode.Uri.parse(service.url), { Authorization: `Bearer ${token}` }, context.extension.packageJSON.version)],
    }));
    const publish = async () => {
      await heartbeat();
      // Independent registrations: a read-only project must not prevent global Codex setup.
      const outcomes = await Promise.allSettled([
        registerCodex(process.env.CODEX_HOME || join(homedir(), '.codex'), storage, process.execPath, join(context.extensionPath, 'dist', 'agent-bridge.js')),
        ...roots().map(root => publishConnection(root, service.url, token)),
      ]);
      registered = outcomes[0].status === 'fulfilled';
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      setupError = failures.length ? failures.map(failure => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join('\n') : undefined;
      renderStatus();
      if (setupError) { serviceLog.appendLine(`自动接入未全部完成：${setupError}`); }
      else { serviceLog.appendLine('VS Code / Codex 自动接入已注册，等待 Agent 请求；无需配置端口和令牌。'); }
    };
    register('enableAiConnection', async () => {
      await publish();
      if (setupError) { serviceLog.show(true); }
      else { void vscode.window.showInformationMessage(lastActivity ? 'AI 已访问协作终端，接入正常。' : '自动接入已完成。首次接入前已运行的 Codex 如未显示工具，请重启 Codex 客户端；以后无需配置。'); }
    });
    // No opt-in flag: activation itself prepares the connection for agents.
    try { await publish(); }
    catch (error) { setupError = String(error); renderStatus(); serviceLog.appendLine(`自动接入失败：${setupError}`); }
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void publish().catch(error => { setupError = String(error); renderStatus(); });
    }));
    register('mcpConfig', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content: '// 当前 VS Code 窗口的 MCP 配置。令牌允许操作共享终端，请勿提交到 Git。\n// VS Code 已自动注册此服务；其他支持 Streamable HTTP 的 MCP 客户端可使用以下 URL 和请求头。\n// 默认端口在重载窗口后变化；需要固定端口时设置 sharedTerminal.mcpPort。\n' + JSON.stringify({ servers: { 'shared-terminal': { type: 'http', url: service.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) });
      await vscode.window.showTextDocument(document);
    });
  } catch (error) {
    status.text = '$(warning) 协作 MCP 未启动';
    status.tooltip = String(error);
    serviceLog.appendLine(`MCP startup failed: ${String(error)}`);
    register('mcpConfig', () => { throw new Error(`MCP 服务未启动：${String(error)}。请检查端口设置后重新加载窗口。`); });
    register('enableAiConnection', () => { throw new Error('MCP 服务尚未启动，请查看“协作终端 · 服务”输出。'); });
    void vscode.window.showErrorMessage(`协作终端 MCP 服务启动失败：${String(error)}。终端功能仍可使用。`);
  }
  status.show();
}

export async function deactivate(): Promise<void> { await shutdown?.(); shutdown = undefined; }
