import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { Session } from './session';
import { SerialWriter } from './serial-writer';

export interface SshProfile { name: string; host: string; port?: number; username: string; privateKeyPath?: string; agent?: string }
export interface SerialOptions {
  path: string; baudRate: number; dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2; parity: 'none' | 'even' | 'odd' | 'mark' | 'space'; rtscts: boolean;
}

export async function listSerialPorts() {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
}

export async function connectSerial(session: Session, options: SerialOptions): Promise<void> {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({ ...options, autoOpen: false });
  await attachSerial(session, port);
}

interface SerialDevice {
  readonly isOpen: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  open(callback: (error: Error | null) => void): unknown;
  write(data: Buffer, callback: (error?: Error | null) => void): unknown;
  drain(callback: (error: Error | null) => void): unknown;
  close(callback: (error: Error | null) => void): unknown;
}

export async function attachSerial(session: Session, port: SerialDevice): Promise<void> {
  port.on('data', (data: Buffer) => session.output(data));
  port.on('error', (error: Error) => { session.status(error.message); session.close('Serial error'); });
  port.on('close', () => session.close('Serial disconnected'));
  session.once('closed', () => { if (port.isOpen) { port.close(() => {}); } });
  await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
  const writer = new SerialWriter(data => new Promise<void>((resolve, reject) => {
    port.write(data, error => error ? reject(error) : port.drain(err => err ? reject(err) : resolve()));
  }));
  session.once('closed', () => writer.close());
  if (session.state === 'closed') { writer.close(); }
  session.attach({
    write: async data => {
      try { await writer.write(data); }
      catch (error) {
        if (writer.isClosed) { session.close('Serial write failed or disconnected'); }
        throw error;
      }
    },
    close: () => { if (port.isOpen) { port.close(() => {}); } },
  });
}

export async function connectLocal(session: Session, shell: string, cwd: string): Promise<void> {
  const pty = await import('node-pty');
  if (session.state === 'closed') { return; }
  const child = pty.spawn(shell, [], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: process.env, useConptyDll: process.platform === 'win32' });
  child.onData(data => session.output(data));
  child.onExit(event => session.close(`Process exited (${event.exitCode})`));
  session.attach({ write: data => child.write(data.toString('utf8')), resize: (cols, rows) => child.resize(cols, rows), close: () => child.kill() });
}

export async function connectSsh(
  session: Session, profile: SshProfile,
  credentials: { password?: string; passphrase?: string },
  verifyHost: (hash: string) => Promise<boolean>,
): Promise<void> {
  const client = new Client();
  const config: ConnectConfig = {
    host: profile.host, port: profile.port ?? 22, username: profile.username,
    ...credentials, agent: profile.agent, readyTimeout: 120000, keepaliveInterval: 15000,
    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => { void verifyHost(createHash('sha256').update(key).digest('hex')).then(callback, () => callback(false)); },
  };
  if (profile.privateKeyPath) {
    const path = profile.privateKeyPath.replace(/^~(?=[/\\])/, homedir());
    config.privateKey = await readFile(path);
  }
  if (session.state === 'closed') { return; }
  await new Promise<void>((resolve, reject) => {
    session.once('closed', () => { client.end(); reject(new Error('SSH session closed')); });
    client.on('error', error => { reject(error); session.close(`SSH: ${error.message}`); });
    client.on('close', () => { reject(new Error('SSH connection closed')); session.close('SSH disconnected'); });
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) => {
        if (error) { client.end(); reject(error); return; }
        stream.on('data', (data: Buffer) => session.output(data));
        stream.stderr.on('data', (data: Buffer) => session.output(data));
        stream.on('error', (err: Error) => session.close(`SSH stream: ${err.message}`));
        stream.on('close', () => session.close('SSH shell exited'));
        session.attach({
          write: data => new Promise<void>((done, fail) => stream.write(data, (err?: Error | null) => err ? fail(err) : done())),
          resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
          close: () => { stream.end(); client.end(); },
        });
        resolve();
      });
    });
    client.connect(config);
  });
}
