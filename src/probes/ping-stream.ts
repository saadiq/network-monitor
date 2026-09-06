// §4.2 long-lived `/sbin/ping -n -i 1 -s 16 <host>`: spawn (stdout + stderr), feed the parser,
// stall watchdog, restart with backoff, generation counter, retarget. Side-effecting (child
// process + timers). The spawner defaults to §9 streamLines and is injectable for tests.
import { BIN, PING_PAYLOAD_BYTES, STREAM_BACKOFF_MS, STREAM_RESTART_MS, STREAM_STALL_MS } from '../config';
import { monoNow } from '../core/clock';
import { streamLines } from '../core/proc';
import { parsePingLine } from './ping-parse';
import type { PingEvent } from './types';

/** §9 `streamLines` contract (structural copy so a fake spawner needs no proc.ts types). */
export interface LineSink {
  onLine(line: string, src: 'stdout' | 'stderr'): void;
  onExit(code: number | null): void;
}
export interface StreamHandle { kill(): void; pid: number; startedAt: number }
export type Spawner = (argv: string[], h: LineSink) => StreamHandle;
export type PingEventHandler = (e: PingEvent, at: number, gen: number) => void;

const WATCHDOG_MS = 500;
/** A process that lived this long before failing resets the restart backoff. */
const HEALTHY_RUN_MS = 30000;

export function pingArgv(host: string): string[] {
  return [BIN.ping, '-n', '-i', '1', '-s', String(PING_PAYLOAD_BYTES), host];
}

export class PingStream {
  private handler: PingEventHandler | null = null;
  private handle: StreamHandle | null = null;
  private spawnId = 0; // invalidates callbacks of killed processes
  private exitedId = -1;
  private gen = 0;
  private host: string | null = null;
  private running = false;
  private lastLineAt = 0;
  private spawnedAt = 0;
  private backoffIdx = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly spawn: Spawner = streamLines, private readonly now: () => number = monoNow) {}

  /** Current generation (bumped on every spawn: start, restart, retarget). 0 before start. */
  get generation(): number {
    return this.gen;
  }

  get target(): string | null {
    return this.host;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Events carry the arrival time (monotonic) and the generation of the process that printed the line. */
  onEvent(cb: PingEventHandler): void {
    this.handler = cb;
  }

  start(host: string): void {
    if (this.running) {
      this.retarget(host);
      return;
    }
    this.running = true;
    this.host = host;
    this.backoffIdx = 0;
    this.launch();
    this.watchdog = setInterval(() => this.check(this.now()), WATCHDOG_MS);
  }

  /** Kill and restart immediately with a generation bump (§4.2); no backoff. */
  retarget(host: string): void {
    if (!this.running) {
      this.start(host);
      return;
    }
    this.host = host;
    this.backoffIdx = 0;
    this.clearRestart();
    this.killCurrent();
    this.launch();
  }

  stop(): void {
    this.running = false;
    this.clearRestart();
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.killCurrent();
  }

  /** §4.2: no line of any kind for ≥ 3 s, or no live process → the window marks seconds UNMEASURED. */
  stalled(now: number): boolean {
    if (!this.running || !this.handle) return true;
    return now - this.lastLineAt >= STREAM_STALL_MS;
  }

  /** Watchdog step: stall ≥ 5 s → kill and restart with backoff. Runs every 500 ms; public for tests. */
  check(now: number): void {
    if (!this.running) return;
    if (!this.handle) {
      if (!this.restartTimer) this.scheduleRestart(now);
      return;
    }
    if (now - this.lastLineAt >= STREAM_RESTART_MS) this.scheduleRestart(now);
  }

  private launch(): void {
    const id = ++this.spawnId;
    const gen = ++this.gen;
    const at = this.now();
    this.spawnedAt = at;
    this.lastLineAt = at;
    const h = this.spawn(pingArgv(this.host as string), {
      onLine: (line) => this.onLine(id, gen, line),
      onExit: () => this.onExit(id),
    });
    if (this.exitedId !== id) this.handle = h; // onExit may have fired synchronously (spawn failure)
    this.emit({ kind: 'ignore' }, at, gen); // spawn marker: seeds the window's sendEpoch (§4.2)
  }

  private onLine(id: number, gen: number, line: string): void {
    if (id !== this.spawnId) return;
    const at = this.now();
    this.lastLineAt = at;
    this.emit(parsePingLine(line), at, gen);
  }

  private onExit(id: number): void {
    if (id !== this.spawnId) return;
    this.exitedId = id;
    this.handle = null;
    if (this.running) this.scheduleRestart(this.now());
  }

  private scheduleRestart(now: number): void {
    if (this.restartTimer) return;
    this.killCurrent();
    if (now - this.spawnedAt >= HEALTHY_RUN_MS) this.backoffIdx = 0;
    const i = Math.min(this.backoffIdx, STREAM_BACKOFF_MS.length - 1);
    const delay = STREAM_BACKOFF_MS[i] ?? STREAM_RESTART_MS;
    this.backoffIdx++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running) this.launch();
    }, delay);
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killCurrent(): void {
    const h = this.handle;
    this.handle = null;
    this.spawnId++; // late lines / exit of the old process are ignored
    if (!h) return;
    try {
      h.kill();
    } catch {
      // already gone
    }
  }

  private emit(e: PingEvent, at: number, gen: number): void {
    this.handler?.(e, at, gen);
  }
}
