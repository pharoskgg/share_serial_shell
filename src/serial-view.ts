import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Sessions, Session, type Entry } from './session';
import { listSerialPorts, type SerialOptions } from './backends';
import { serialInput, serialSchema } from './serial-options';
import { revealSerialView, SerialViewUnavailableError } from './reveal-view';

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('connect'), options: z.object(serialSchema) }),
  z.object({ type: z.literal('select'), sessionId: z.string().uuid() }),
  z.object({ type: z.literal('disconnect'), sessionId: z.string().uuid() }),
  z.object({ type: z.literal('export'), sessionId: z.string().uuid() }),
  z.object({ type: z.literal('terminal'), sessionId: z.string().uuid() }),
  z.object({ type: z.literal('send'), sessionId: z.string().uuid(), data: z.string().max(65536), encoding: z.enum(['utf8', 'hex']), ending: z.enum(['none', 'cr', 'lf', 'crlf']) }),
]);

export class SerialView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selected?: string;
  private ports: Awaited<ReturnType<typeof listSerialPorts>> = [];
  private scanError = '';
  private connecting = false;
  private scanning = false;
  private ready = false;
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private queue: Entry[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = () => this.pushState();
  private readonly entry = (session: Session, entry: Entry) => {
    if (session.id !== this.selected || !this.ready || !this.view?.visible) { return; }
    this.queue.push(entry);
    // Flush at most 20 times/sec and bound each batch under sustained serial traffic.
    if (this.queue.length >= 200) { this.flush(); }
    else if (!this.flushTimer) { this.flushTimer = setTimeout(() => this.flush(), 50); }
  };

  constructor(private readonly context: vscode.ExtensionContext, private readonly sessions: Sessions, private readonly openSerial: (options: SerialOptions) => Promise<Session>, private readonly showTerminal: (id: string) => void) {
    sessions.on('change', this.changed);
    sessions.on('entry', this.entry);
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    this.disposables.push(view.webview.onDidReceiveMessage(raw => { void this.handle(raw); }));
    this.disposables.push(view.onDidChangeVisibility(() => {
      if (view.visible && this.ready) { this.pushState(); this.snapshot(); void this.refresh(); }
    }));
    this.disposables.push(view.onDidDispose(() => { this.view = undefined; this.ready = false; }));
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const html = await readFile(vscode.Uri.joinPath(media, 'serial.html').fsPath, 'utf8');
    view.webview.html = html
      .replaceAll('{{cspSource}}', view.webview.cspSource)
      .replaceAll('{{nonce}}', randomBytes(16).toString('hex'))
      .replaceAll('{{styleUri}}', view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'serial.css')).toString())
      .replaceAll('{{scriptUri}}', view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'serial.js')).toString());
    if (!this.timer) { this.timer = setInterval(() => { if (this.view?.visible && this.ready) { void this.refresh(); } }, 3000); }
  }

  async reveal(session?: Session): Promise<void> {
    if (session) { this.selected = session.id; }
    await revealSerialView({
      showResolvedView: () => { if (!this.view) { return false; } this.view.show(true); return true; },
      commands: async () => vscode.commands.getCommands(true),
      execute: async command => vscode.commands.executeCommand(command),
    });
    this.view?.show(true);
    const deadline = Date.now() + 10000;
    while (!this.ready && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); }
    if (!this.ready) { throw new SerialViewUnavailableError(); }
    this.pushState(); this.snapshot();
  }

  private post(message: unknown): void { if (this.view && this.ready) { void this.view.webview.postMessage(message); } }
  private pushState(): void {
    if (!this.selected) { this.selected = this.sessions.list().filter(s => s.kind === 'serial').at(-1)?.id; }
    this.post({ type: 'state', ports: this.ports, scanError: this.scanError, connecting: this.connecting, selected: this.selected,
      sessions: this.sessions.list().filter(s => s.kind === 'serial').map(s => s.info()), defaults: this.context.workspaceState.get('serialOptions') });
  }
  private flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.queue.length) { this.post({ type: 'events', sessionId: this.selected, events: this.queue }); this.queue = []; }
  }
  private snapshot(): void {
    this.queue = [];
    let events: Entry[] = [];
    if (this.selected) {
      try { events = this.serialSession(this.selected).read(0, 10000).events.slice(-1000); } catch { this.selected = undefined; }
    }
    this.post({ type: 'snapshot', sessionId: this.selected, events });
  }
  private serialSession(id: string): Session {
    const session = this.sessions.get(id);
    if (session.kind !== 'serial') { throw new Error('请选择串口会话'); }
    return session;
  }
  private async exportSession(id: string): Promise<void> {
    const session = this.serialSession(id);
    const safeName = session.name.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'serial-session';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${safeName}.txt`),
      filters: { '文本文件': ['txt'], '所有文件': ['*'] },
      saveLabel: '导出串口记录',
    });
    if (!uri) { return; }
    const lines = session.history().map(entry => {
      const badge = entry.type === 'output' ? 'RX' : entry.type === 'input' ? (entry.actor === 'ai' ? 'AI' : 'TX') : 'STATUS';
      return `${entry.time} [${badge}] ${entry.data}`;
    });
    await writeFile(uri.fsPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    void vscode.window.showInformationMessage(`已导出 ${lines.length} 条串口记录：${uri.fsPath}`);
  }
  private async refresh(): Promise<void> {
    if (this.scanning) { return; }
    this.scanning = true;
    try { this.ports = await listSerialPorts(); this.scanError = ''; }
    catch (error) { this.scanError = `串口枚举失败：${error instanceof Error ? error.message : String(error)}`; }
    finally { this.scanning = false; this.pushState(); }
  }
  private async handle(raw: unknown): Promise<void> {
    try {
      const message = messageSchema.parse(raw);
      if (message.type === 'ready') { this.ready = true; this.pushState(); this.snapshot(); await this.refresh(); }
      else if (message.type === 'refresh') { await this.refresh(); }
      else if (message.type === 'connect') {
        if (this.connecting) { return; }
        this.connecting = true; this.pushState();
        try {
          await this.context.workspaceState.update('serialOptions', message.options);
          const session = await this.openSerial(message.options);
          this.selected = session.id;
          this.snapshot();
        } finally { this.connecting = false; this.pushState(); }
      } else if (message.type === 'select') {
        this.serialSession(message.sessionId); this.selected = message.sessionId; this.pushState(); this.snapshot();
      } else if (message.type === 'disconnect') { this.serialSession(message.sessionId).close('Disconnected by user'); }
      else if (message.type === 'export') { await this.exportSession(message.sessionId); }
      else if (message.type === 'terminal') { this.serialSession(message.sessionId); this.showTerminal(message.sessionId); }
      else if (message.type === 'send') {
        await this.serialSession(message.sessionId).write(serialInput(message.data, message.encoding, message.ending), 'human');
        this.post({ type: 'sent' });
      }
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }
  dispose(): void {
    clearInterval(this.timer); clearTimeout(this.flushTimer);
    this.sessions.off('change', this.changed); this.sessions.off('entry', this.entry);
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}
