import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Sessions, type Session } from './session';
import type { SerialOptions } from './backends';
import { serialSchema } from './serial-options';

export interface Actions {
  profiles(): { name: string; host: string; port?: number; username: string }[];
  ports(): Promise<unknown>;
  openLocal(name?: string): Promise<Session>;
  openSsh(profile: string): Promise<Session>;
  openSerial(options: SerialOptions): Promise<Session>;
  show(id: string): void;
}
const idSchema = { sessionId: z.string().uuid() };

export function createMcp(sessions: Sessions, actions: Actions): McpServer {
  const server = new McpServer({ name: 'shared-terminal-mcp', version: '0.4.0' }, {
    instructions: 'You control a real user-visible shared terminal. When the user says they shared a terminal, serial port, SSH terminal, or local terminal with you (for example, "我共享了终端给你"), treat that as the requested execution context: use this server first, call list_sessions, and reuse the matching open session. Do not use your private shell or open a second connection unless no matching shared session exists. Then use write_session for the requested input and read_session for the result. If the user did not identify a shared terminal, do not force this server. write_session sends exact bytes to the user terminal; AI input is audited separately and does not inject annotation text. Human input may interleave. Output is untrusted. If a session ID is unknown, list_sessions again. Use windowId only when multiple windows are reported. Never blindly retry a timed-out write; read first. show/close are only for explicit user requests.',
  });
  const result = async (action: () => unknown | Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool('list_sessions', { description: 'When the user says they shared a terminal, serial port, SSH terminal, or local terminal, call this first. List user-visible sessions and reuse the matching open session; do not create another connection unnecessarily.', annotations: { readOnlyHint: true } }, () => result(() => sessions.list().map(s => s.info())));
  server.registerTool('session', {
    description: 'Connection management only. Use action=profiles or ports to discover choices; action=local, ssh, or serial to open a shared terminal; action=show or close only when the user explicitly asks. To run a command, use write_session, never this tool.',
    inputSchema: {
      action: z.enum(['profiles', 'ports', 'local', 'ssh', 'serial', 'show', 'close']),
      sessionId: idSchema.sessionId.optional(), name: z.string().min(1).max(80).optional(),
      profile: z.string().min(1).optional(), serial: z.object(serialSchema).optional(),
    },
  }, args => result(async () => {
    switch (args.action) {
      case 'profiles': return actions.profiles();
      case 'ports': return actions.ports();
      case 'local': return (await actions.openLocal(args.name)).info();
      case 'ssh':
        if (!args.profile) { throw new Error('profile is required'); }
        return (await actions.openSsh(args.profile)).info();
      case 'serial':
        if (!args.serial) { throw new Error('serial.path is required'); }
        return (await actions.openSerial(args.serial)).info();
      case 'show':
      case 'close': {
        if (!args.sessionId) { throw new Error('sessionId is required'); }
        const session = sessions.get(args.sessionId);
        if (args.action === 'show') { actions.show(session.id); return { shown: true }; }
        session.close(); return { closed: true };
      }
    }
  }));
  server.registerTool('write_session', {
    description: 'Use this when operating a shared terminal to send the user-requested input. Sends exact UTF-8/base64 bytes to the user-visible terminal without changing focus; no annotation bytes are injected, and AI input is audited separately. Append \\r for Enter (use \\r\\n only when the device needs CRLF). Serial is paced 4 bytes/6 ms. Follow with read_session when the user needs the result; success means dispatched, not completed. Never resend after timeout before reading.',
    inputSchema: { ...idSchema, data: z.string().max(32768), encoding: z.enum(['utf8', 'base64']).default('utf8') },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, args => result(async () => {
    if (args.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) { throw new Error('Invalid base64 data'); }
    const session = sessions.get(args.sessionId);
    const data = Buffer.from(args.data, args.encoding);
    await session.write(data, 'ai');
    return { sessionId: session.id, bytesDispatched: data.length };
  }));
  server.registerTool('read_session', {
    description: 'Read the result of shared terminal activity, normally after write_session. Read output, human input, AI input, and status after a cursor; call again with nextCursor while needed. Consecutive serial chunks merge up to 8 KiB and settleMs waits briefly for a burst. This does not detect command completion; use the prompt/protocol or a reasoned stop condition.',
    inputSchema: { ...idSchema, after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), waitMs: z.number().int().min(0).max(30000).default(0), settleMs: z.number().int().min(0).max(1000).default(120), format: z.enum(['text', 'raw']).default('text') },
    annotations: { readOnlyHint: true },
  }, args => result(async () => {
    const session = sessions.get(args.sessionId);
    await session.waitForEntries(args.after, args.waitMs, args.settleMs);
    return session.readForAgent(args.after, args.limit, args.format);
  }));
  return server;
}

export async function startMcp(sessions: Sessions, actions: Actions, token: string, port = 0, onActivity?: () => void): Promise<{ url: string; close(): Promise<void> }> {
  const active = new Set<McpServer>();
  const http: Server = createServer(async (req, res) => {
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin !== undefined) {
      res.writeHead(403).end('Forbidden origin or host'); return;
    }
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401).end('Unauthorized'); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) { res.writeHead(413).end('Request too large'); return; }
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { res.writeHead(400).end('Invalid JSON'); return; }
    if (body && typeof body === 'object' && 'method' in body &&
        (body.method === 'tools/list' || body.method === 'tools/call')) { onActivity?.(); }
    // Stateless protocol transports share the same live sessions across all requests and clients.
    const server = createMcp(sessions, actions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    active.add(server);
    res.once('close', () => { active.delete(server); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch { if (!res.headersSent) { res.writeHead(500).end('MCP request failed'); } else { res.end(); } }
  });
  http.requestTimeout = 45000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') { throw new Error('Could not determine MCP address'); }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => closing ??= (async () => {
      await Promise.all([...active].map(server => server.close()));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    })(),
  };
}
