/**
 * One long-lived `adb -s <serial> shell` per device for latency-sensitive input
 * (tap / swipe / key / text). Spawning a fresh adb client per command costs tens to
 * hundreds of ms on Windows; writing a line into an open shell costs ~nothing.
 *
 * Commands are pipelined: each is written immediately and the device's sh runs them in
 * order, so order is preserved without waiting for the previous one. Every command is
 * wrapped as
 *     sh -c '<cmd>' </dev/null 2>&1; echo "__KMM_<id>_$?__"
 * so a malformed command can only break its own child sh (never the session parser),
 * it cannot swallow our stdin, and the marker gives us its output and exit code.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MARKER_RE = /__KMM_(\d+)_(\d+)__\r?\n?/;

interface Pending {
  id: number;
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** POSIX single-quote a string for sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private queue: Pending[] = [];
  private seq = 0;
  private dead = false;
  lastUsedAt = Date.now();

  constructor(private readonly spawnShell: () => ChildProcessWithoutNullStreams) {}

  get isDead(): boolean {
    return this.dead;
  }

  run(command: string, timeoutMs = 15_000): Promise<string> {
    if (this.dead) return Promise.reject(new Error('shell closed'));
    const proc = this.ensure();
    this.lastUsedAt = Date.now();
    const id = ++this.seq;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A stuck command blocks everything queued behind it — restart the session.
        this.destroy(new Error(`persistent shell: command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.queue.push({ id, resolve, reject, timer });
      proc.stdin.write(`sh -c ${shQuote(command)} </dev/null 2>&1; echo "__KMM_${id}_$?__"\n`);
    });
  }

  close(): void {
    this.destroy(new Error('shell closed'));
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = this.spawnShell();
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.on('data', () => { /* command stderr is merged into stdout via 2>&1 */ });
    proc.stdin.on('error', () => { /* surfaced through 'exit' */ });
    proc.on('error', (err) => this.destroy(err));
    proc.on('exit', (code) => this.destroy(new Error(`adb shell exited (code ${code})`)));
    return proc;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(this.buf))) {
      const output = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const head = this.queue.shift();
      if (!head) continue;
      clearTimeout(head.timer);
      if (Number(m[1]) !== head.id) {
        // Should never happen (sh runs lines in order) — fail safe and resync.
        head.reject(new Error('persistent shell: out-of-order reply'));
        this.destroy(new Error('persistent shell: out-of-order reply'));
        return;
      }
      const code = Number(m[2]);
      if (code === 0) head.resolve(output);
      else head.reject(new Error(`exit ${code}: ${output.trim().slice(0, 500)}`));
    }
  }

  private destroy(err: Error): void {
    this.dead = true;
    const proc = this.proc;
    this.proc = null;
    for (const p of this.queue) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.queue = [];
    if (proc) {
      try { proc.stdin.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    }
  }
}
