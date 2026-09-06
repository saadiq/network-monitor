// §9 Process primitive: the only module that spawns children. Never throws.
// One-shot commands use run(); the two ping streams use streamLines().
import type { Subprocess } from 'bun';
import { monoNow } from './clock';

export type RunResult = {
  ok: boolean;
  code: number | null; // null when killed by a signal or never spawned
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  err?: 'ENOENT' | 'SPAWN';
};

export type StreamHandle = { kill(): void; pid: number; startedAt: number };

export type LineSource = 'stdout' | 'stderr';
export type StreamHandlers = {
  onLine(line: string, src: LineSource): void;
  onExit(code: number | null): void;
};

/** SIGKILL follows SIGTERM after this (§9); also bounds pipe draining after exit. */
const KILL_GRACE_MS = 500;

type Child = Subprocess<'ignore', 'pipe', 'pipe'>;
type ByteStream = ReadableStream<Uint8Array>;

// ---- registry (§8.3 shutdown → killAll) ----------------------------------------

const children = new Set<Child>();

function track(p: Child): void {
  children.add(p);
  const drop = () => { children.delete(p); };
  p.exited.then(drop, drop);
}

function signal(p: Child, sig: 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (p.exitCode === null && p.signalCode === null) p.kill(sig);
  } catch { /* already gone */ }
}

/** SIGTERM every live child. Called once on shutdown; safe to call repeatedly. */
export function killAll(): void {
  for (const p of children) signal(p, 'SIGTERM');
}

/** Number of live registered children (for tests / diagnostics). */
export function childCount(): number {
  return children.size;
}

type SpawnOutcome = { proc: Child } | { err: 'ENOENT' | 'SPAWN' };

function spawn(argv: string[]): SpawnOutcome {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    track(proc);
    return { proc };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return { err: code === 'ENOENT' ? 'ENOENT' : 'SPAWN' };
  }
}

// ---- pipe readers ----------------------------------------------------------------

type Drain = { done: Promise<void>; abort(): void };

/**
 * Pump a pipe through a TextDecoder until EOF (or abort). `onChunk` receives decoded
 * text; `abort()` resolves a pending read so a grandchild holding the pipe cannot
 * hang us after the child itself has exited.
 */
function drain(stream: ByteStream | null | undefined, onChunk: (text: string) => void): Drain {
  if (!stream) return { done: Promise.resolve(), abort() {} };
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (value) onChunk(dec.decode(value, { stream: true }));
      }
    } catch { /* cancelled or pipe error: keep what we have */ }
    const tail = dec.decode();
    if (tail) onChunk(tail);
  })();
  return { done, abort: () => { reader.cancel().catch(() => {}); } };
}

/** Wait for both drains, but no longer than KILL_GRACE_MS once the child has exited. */
async function settleDrains(exited: Promise<unknown>, drains: Drain[]): Promise<void> {
  const all = Promise.all(drains.map((d) => d.done));
  await exited;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cutoff = new Promise<void>((res) => {
    timer = setTimeout(() => { for (const d of drains) d.abort(); res(); }, KILL_GRACE_MS);
  });
  await Promise.race([all, cutoff]);
  if (timer) clearTimeout(timer);
  await all;
}

// ---- run() -----------------------------------------------------------------------

/**
 * Run a one-shot command. SIGTERM at timeoutMs, SIGKILL 500 ms later. Spawn failures
 * are reported via `err`. ok = exit 0 && !timedOut && !err.
 */
export async function run(argv: string[], timeoutMs: number): Promise<RunResult> {
  const t0 = monoNow();
  const spawned = spawn(argv);
  if ('err' in spawned) {
    return { ok: false, code: null, stdout: '', stderr: '', ms: monoNow() - t0, timedOut: false, err: spawned.err };
  }
  const { proc } = spawned;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const term = setTimeout(() => { timedOut = true; signal(proc, 'SIGTERM'); }, timeoutMs);
  const kill = setTimeout(() => signal(proc, 'SIGKILL'), timeoutMs + KILL_GRACE_MS);
  const drains = [
    drain(proc.stdout, (t) => { stdout += t; }),
    drain(proc.stderr, (t) => { stderr += t; }),
  ];
  try {
    await settleDrains(proc.exited, drains);
  } catch { /* exited never rejects in practice; stay silent regardless */ }
  clearTimeout(term);
  clearTimeout(kill);
  const code = proc.exitCode;
  return { ok: code === 0 && !timedOut, code, stdout, stderr, ms: monoNow() - t0, timedOut };
}

// ---- streamLines() ---------------------------------------------------------------

/** Splits decoded text into lines; keeps a partial trailing line until more data or EOF. */
class LineSplitter {
  private buf = '';
  constructor(private readonly src: LineSource, private readonly onLine: StreamHandlers['onLine']) {}

  feed(text: string): void {
    this.buf += text;
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      this.emit(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
    }
  }

  /** EOF: deliver a non-empty remainder as the final line. */
  flush(): void {
    if (this.buf) this.emit(this.buf);
    this.buf = '';
  }

  private emit(line: string): void {
    this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line, this.src);
  }
}

/**
 * Spawn a long-lived process and deliver complete lines from stdout and stderr.
 * onExit fires exactly once, after the last line, with the exit code (null when
 * killed by a signal). A spawn failure yields pid −1 and onExit(null) on a later turn.
 */
export function streamLines(argv: string[], h: StreamHandlers): StreamHandle {
  const startedAt = monoNow();
  const spawned = spawn(argv);
  if ('err' in spawned) {
    setTimeout(() => h.onExit(null), 0);
    return { kill() {}, pid: -1, startedAt };
  }
  const { proc } = spawned;
  const out = new LineSplitter('stdout', h.onLine);
  const err = new LineSplitter('stderr', h.onLine);
  const drains = [drain(proc.stdout, (t) => out.feed(t)), drain(proc.stderr, (t) => err.feed(t))];
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  void settleDrains(proc.exited, drains).then(() => {
    if (killTimer) clearTimeout(killTimer);
    out.flush();
    err.flush();
    h.onExit(proc.exitCode);
  });
  return {
    pid: proc.pid,
    startedAt,
    kill() {
      if (killTimer) return; // idempotent
      signal(proc, 'SIGTERM');
      killTimer = setTimeout(() => signal(proc, 'SIGKILL'), KILL_GRACE_MS);
    },
  };
}

// ---- preflight() -----------------------------------------------------------------

/** The subset of `paths` that does not exist (§3: a missing binary disables its probe). */
export async function preflight(paths: string[]): Promise<Set<string>> {
  const checks = paths.map(async (p) => {
    try {
      return (await Bun.file(p).exists()) ? null : p;
    } catch {
      return p;
    }
  });
  const missing = new Set<string>();
  for (const p of await Promise.all(checks)) if (p !== null) missing.add(p);
  return missing;
}
