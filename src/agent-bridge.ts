import { readFile, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcp, type Actions } from './mcp';
import { Sessions } from './session';
import type { WindowEndpoint } from './agent-setup';

const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function payload(response: CallToolResult): any {
  if (response.isError) { throw new Error(response.content.find(x => x.type === 'text')?.text ?? 'Terminal request failed'); }
  const text = response.content.find(x => x.type === 'text');
  if (!text || text.type !== 'text') { throw new Error('Invalid terminal response'); }
  return JSON.parse(text.text);
}

/** Publish tools even when VS Code isn't running yet. No SSH is opened here. */
async function toolDefinitions(): Promise<Tool[]> {
  const sessions = new Sessions();
  const unavailable = async (): Promise<never> => { throw new Error('Not connected'); };
  const actions: Actions = { profiles: () => [], ports: unavailable, openLocal: unavailable, openSsh: unavailable, openSerial: unavailable, show() {} };
  const server = createMcp(sessions, actions);
  const client = new Client({ name: 'shared-terminal-schema', version: '0.4.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await client.connect(right);
    const tools = (await client.listTools()).tools;
    return tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, windowId: { type: 'string', description: 'Optional VS Code window ID; set this when list_sessions/list_windows shows multiple windows.' } } } }));
  } finally { await client.close(); await server.close(); sessions.dispose(); }
}

export class WindowRouter {
  constructor(private readonly directory: string, private readonly cwd = process.cwd()) {}

  async endpoints(): Promise<WindowEndpoint[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
    const entries = await Promise.all(files.filter(file => /^[a-f0-9-]+\.json$/i.test(file)).map(async file => {
      try {
        const value = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as WindowEndpoint;
        if (!/^[a-f0-9-]+$/i.test(value.id) || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(value.url) ||
          typeof value.token !== 'string' || !value.token || typeof value.label !== 'string' ||
          !Array.isArray(value.roots) || !value.roots.every(root => typeof root === 'string') ||
          !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now()) { return undefined; }
        return value;
      } catch { return undefined; }
    }));
    return entries.filter((entry): entry is WindowEndpoint => !!entry);
  }

  private async call(endpoint: WindowEndpoint, name: string, args: Record<string, unknown>, timeout = 180000): Promise<CallToolResult> {
    const client = new Client({ name: 'shared-terminal-agent', version: '0.4.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(timeout) },
      }), { timeout: Math.min(timeout, 3000) });
      return await client.callTool({ name, arguments: args }, undefined, { timeout }) as CallToolResult;
    } catch {
      // Never retry writes: a dropped response may still have executed the input.
      throw new Error(`窗口 ${endpoint.label} (${endpoint.id}) 请求未完成；请先读取会话确认结果，勿自动重发输入。`);
    } finally { await client.close(); }
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const windows = await this.endpoints();
    if (name === 'list_windows') { return result(windows.map(({ id, label, roots }) => ({ windowId: id, label, roots }))); }
    if (!windows.length) { throw new Error('尚无可用的协作终端窗口。请打开已安装插件的受信任 VS Code 项目；连接会自动恢复，无需配置。'); }
    const explicit = args.windowId;
    if (explicit !== undefined && (typeof explicit !== 'string' || !windows.some(w => w.id === explicit))) { throw new Error('窗口已关闭或不存在；请调用 list_windows 刷新。'); }
    const selected = explicit ? windows.filter(w => w.id === explicit) : windows;
    const { windowId: _, ...forwarded } = args;
    if (name === 'list_sessions' || (name === 'session' && args.action === 'profiles')) {
      const responses = await Promise.all(selected.map(async window => {
        try { return { windowId: window.id, items: payload(await this.call(window, name, forwarded, 2000)), window }; }
        catch { return { windowId: window.id, error: '窗口暂时不可用' }; }
      }));
      const items = responses.flatMap(response => response.items?.map((item: object) => ({ ...item, windowId: response.windowId, workspace: response.window!.label })) ?? []);
      // Keep a plain array on success for existing clients, surface partial failures explicitly.
      const errors = responses.filter(response => response.error).map(({ windowId, error }) => ({ windowId, error }));
      return result(errors.length ? { [name === 'list_sessions' ? 'sessions' : 'profiles']: items, unavailableWindows: errors } : items);
    }
    if (typeof args.sessionId === 'string') {
      const responses = await Promise.all(selected.map(async window => {
        try { return (payload(await this.call(window, 'list_sessions', {}, 2000)) as { id: string }[]).some(session => session.id === args.sessionId) ? window : undefined; }
        catch { return undefined; }
      }));
      const found = responses.filter((window): window is WindowEndpoint => !!window);
      if (found.length !== 1) { throw new Error('找不到该会话；请调用 list_sessions 刷新。不会改用其他终端。'); }
      return this.call(found[0], name, forwarded);
    }
    const matching = selected.filter(window => window.roots.some(root => {
      const suffix = relative(root, this.cwd);
      return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
    }));
    const candidates = explicit ? selected : matching.length ? matching : selected;
    if (candidates.length !== 1) { throw new Error('多个 VS Code 窗口可用，请根据 list_windows 返回的项目路径指定 windowId。'); }
    return this.call(candidates[0], name, forwarded);
  }
}

export async function runBridge(directory: string): Promise<void> {
  const router = new WindowRouter(directory);
  const tools = await toolDefinitions();
  tools.push({ name: 'list_windows', description: 'Use only when more than one VS Code window is available and the target is ambiguous; then pass the returned windowId to the other tools.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  const server = new Server({ name: 'shared-terminal-agent', version: '0.4.0' }, {
    capabilities: { tools: {} }, instructions: 'You control a real user-visible shared terminal. When the user says they shared a terminal, serial port, SSH terminal, or local terminal with you (for example, "我共享了终端给你"), use this server first: call list_sessions and reuse the matching open session. Do not use your private shell or open another connection unless no matching shared session exists. Use write_session for the requested input and read_session for the result. If the user did not identify a shared terminal, do not force this server. write_session sends only the requested bytes to the terminal; AI input is audited separately and no annotation text is injected. If sessionId is unknown, list_sessions again. Use list_windows/windowId only for ambiguity. Never blindly retry a timed-out write; read first. show/close only on explicit user request.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!tools.some(tool => tool.name === request.params.name)) { throw new Error('Unknown shared terminal tool'); }
      return await router.invoke(request.params.name, request.params.arguments ?? {});
    } catch (error) { return { ...result(error instanceof Error ? error.message : String(error)), isError: true }; }
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void server.close(); });
}
