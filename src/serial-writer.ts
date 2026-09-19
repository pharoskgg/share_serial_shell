import { setTimeout as delay } from 'node:timers/promises';

/** One FIFO for both actors. Drain each four-byte chunk, then allow the MCU 6 ms. */
export class SerialWriter {
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private readonly abort = new AbortController();
  constructor(private readonly send: (data: Buffer) => Promise<void>) {}
  get isClosed(): boolean { return this.abort.signal.aborted; }

  write(data: Buffer): Promise<void> {
    if (this.abort.signal.aborted) { return Promise.reject(new Error('Serial disconnected')); }
    if (this.queuedBytes + data.length > 16384) {
      return Promise.reject(new Error('Serial send queue full (16 KiB); wait for pending input to finish'));
    }
    const bytes = Buffer.from(data);
    this.queuedBytes += bytes.length;
    const task = this.tail.then(async () => {
      const signal = this.abort.signal;
      signal.throwIfAborted();
      for (let offset = 0; offset < bytes.length; offset += 4) {
        // Also reject if a driver never calls back after unplug/disconnect.
        await new Promise<void>((resolve, reject) => {
          const closed = () => reject(new Error('Serial disconnected'));
          signal.addEventListener('abort', closed, { once: true });
          Promise.resolve().then(() => { signal.throwIfAborted(); return this.send(bytes.subarray(offset, offset + 4)); })
            .then(resolve, reject).finally(() => signal.removeEventListener('abort', closed));
        });
        await delay(6, undefined, { signal });
      }
    }).catch(error => {
      // A partial command must not be followed by another queued command.
      this.close();
      throw error;
    }).finally(() => { this.queuedBytes -= bytes.length; });
    this.tail = task.catch(() => {});
    return task;
  }

  close(): void { this.abort.abort(); }
}
