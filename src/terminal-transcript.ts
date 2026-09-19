import { StringDecoder } from 'node:string_decoder';
import { Session, type Entry } from './session';

/** Presentation only: annotations never re-enter the device or MCP output stream. */
export class TerminalTranscript {
  private pending = '';
  private sink?: (text: string) => void;
  private readonly decoder = new StringDecoder('utf8');
  private readonly data = (chunk: Buffer) => this.display(this.decoder.write(chunk));
  private readonly entry = (entry: Entry) => {
    if (entry.type === 'status') {
      this.display(`\r\n[协作终端] ${entry.data.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\r\n`);
    } else if (entry.type === 'input' && entry.actor === 'ai') {
      // JSON makes Enter, Ctrl+C, ESC and binary input visible without executing them.
      const input = JSON.stringify(entry.data).replace(/[\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      this.display(`\r\n[AI →] ${input}\r\n`);
    }
  };
  private readonly ended = () => this.display(this.decoder.end());
  constructor(private readonly session: Session) {
    session.on('data', this.data);
    session.on('entry', this.entry);
    session.on('closed', this.ended);
  }
  display(text: string): void {
    if (this.sink) { this.sink(text); }
    else { this.pending = (this.pending + text).slice(-1024 * 1024); }
  }
  open(sink: (text: string) => void): void {
    this.sink = sink;
    sink('人和 AI 共享输入 · [AI →] 显示发送尝试（控制字符转义）\r\n' + this.pending);
    this.pending = '';
  }
  dispose(): void {
    this.session.off('data', this.data);
    this.session.off('entry', this.entry);
    this.session.off('closed', this.ended);
    this.sink = undefined;
    this.pending = '';
  }
}
