// §8.3 idempotent shutdown. Side-effecting: process signals, stderr, process.exit.
// Order: restore the terminal (registered by Tty) → print an uncaught error, if any →
// run hooks (ticker stop, killAll, log close, quit report — registered by main) → exit.

export type ShutdownHook = (reason: string) => void;

const hooks: ShutdownHook[] = [];
const restorers: Array<() => void> = [];
let installed = false;
let done = false;

/** Register a hook run once at shutdown, after the terminal is restored, in registration order. */
export function onShutdown(fn: ShutdownHook): void {
  hooks.push(fn);
}

/** Register a terminal restorer (runs before hooks). Tty.enter() uses this. */
export function onRestore(fn: () => void): void {
  restorers.push(fn);
}

export function isShuttingDown(): boolean {
  return done;
}

function safe(fn: () => void, what: string): void {
  try {
    fn();
  } catch (e) {
    writeErr(`netmon: ${what} failed: ${errLine(e)}\n`);
  }
}

function writeErr(s: string): void {
  try {
    process.stderr.write(s);
  } catch {
    // stderr gone (SIGHUP); nothing left to tell
  }
}

/** One-line description of a thrown value. */
export function errLine(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.replace(/\s+/g, ' ');
  return String(e).replace(/\s+/g, ' ');
}

/**
 * Restore the terminal, run hooks, exit. Second and later calls are no-ops.
 * `code` 0 by default (q, Ctrl-C, signals); 1 with `err` for uncaught errors (§10).
 */
export function shutdown(reason: string, code = 0, err?: unknown): void {
  if (done) return;
  done = true;
  for (const r of restorers) safe(r, 'terminal restore');
  if (err !== undefined) writeErr(`netmon: ${reason}: ${errLine(err)}\n`);
  for (const h of hooks) safe(() => h(reason), 'shutdown hook');
  if (reason !== 'exit') process.exit(code); // inside process 'exit' the process is already leaving
}

/** Bind shutdown to SIGINT/SIGTERM/SIGHUP, exit, uncaughtException, unhandledRejection (once). */
export function installShutdownHandlers(): void {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(sig));
  process.on('exit', () => shutdown('exit'));
  process.on('uncaughtException', (e) => shutdown('uncaughtException', 1, e));
  process.on('unhandledRejection', (e) => shutdown('unhandledRejection', 1, e));
}
