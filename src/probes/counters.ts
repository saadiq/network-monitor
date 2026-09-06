// §4.7 interface byte counters: parseNetstat + nextCounterSample (pure), CounterPoller (I/O via run()).
import { BIN, COUNTERS_CADENCE_MS, COUNTERS_MAX_DT_MS, COUNTERS_TIMEOUT_MS } from '../config';
import { monoNow } from '../core/clock';
import type { CounterSample } from './types';
import { PollLoop } from './poll-loop';
import { defaultRun, type RunFn } from './runner';

export interface Counters {
  ibytes: number;
  obytes: number;
}

export interface CounterReading extends Counters {
  iface: string;
  at: number; // monotonic ms
}

/** Sum of positive deltas this session (kept across interface changes). */
export interface SessionTotals {
  sessionIn: number;
  sessionOut: number;
}

/**
 * Pick the `<Link#` row of iface (a down interface prints as `iface*`) and read from the
 * end: utun/lo0 rows have no Address token (10 fields instead of 11).
 */
export function parseNetstat(stdout: string, iface: string): Counters | null {
  for (const line of stdout.split('\n')) {
    const t = line.trim().split(/\s+/);
    const name = t[0];
    if ((name !== iface && name !== `${iface}*`) || !t[2]?.startsWith('<Link#')) continue;
    if (t.length < 10) return null;
    const obytes = Number(t[t.length - 2]);
    const ibytes = Number(t[t.length - 5]);
    return Number.isFinite(ibytes) && Number.isFinite(obytes) ? { ibytes, obytes } : null;
  }
  return null;
}

/**
 * Fold one reading into the stream. Rate = Δbytes / Δt (bytes per ms = KB/s, SI); skipped
 * (null rates, zero deltas) on the first sample, interface change, negative Δ, Δt ≤ 0 or > 5 s.
 */
export function nextCounterSample(
  prev: CounterSample | null,
  r: CounterReading,
): { sample: CounterSample; dIn: number; dOut: number } {
  const sample: CounterSample = { iface: r.iface, ibytes: r.ibytes, obytes: r.obytes, at: r.at, inKBs: null, outKBs: null };
  if (prev === null || prev.iface !== r.iface) return { sample, dIn: 0, dOut: 0 };
  const dt = r.at - prev.at;
  const dIn = r.ibytes - prev.ibytes;
  const dOut = r.obytes - prev.obytes;
  if (dt <= 0 || dt > COUNTERS_MAX_DT_MS || dIn < 0 || dOut < 0) return { sample, dIn: 0, dOut: 0 };
  return { sample: { ...sample, inKBs: dIn / dt, outKBs: dOut / dt }, dIn, dOut };
}

export interface CounterPollerOpts {
  iface?: string | null; // countersIface (§4.1.5); null = idle until setIface
  run?: RunFn;
  now?: () => number;
}

export type CounterHandler = (sample: CounterSample, totals: SessionTotals) => void;

/** `netstat -ib -I <iface>` every second (§4.7); emits a sample on every successful read. */
export class CounterPoller {
  private readonly run: RunFn;
  private readonly now: () => number;
  private readonly loop: PollLoop;
  private onSample: CounterHandler | null = null;
  private iface: string | null;
  private prev: CounterSample | null = null;
  private sessionIn = 0;
  private sessionOut = 0;

  constructor(opts: CounterPollerOpts = {}) {
    this.run = opts.run ?? defaultRun;
    this.now = opts.now ?? monoNow;
    this.iface = opts.iface ?? null;
    this.loop = new PollLoop(() => this.poll(), this.now);
  }

  get totals(): SessionTotals {
    return { sessionIn: this.sessionIn, sessionOut: this.sessionOut };
  }

  get currentIface(): string | null {
    return this.iface;
  }

  start(onSample: CounterHandler): void {
    this.onSample = onSample;
    this.loop.schedule(0);
  }

  /** Switch interface (vpn ? wifiIface : egressIface). Totals are kept; the next rate is skipped. */
  setIface(iface: string | null): void {
    if (iface === this.iface) return;
    this.iface = iface;
    this.prev = null;
  }

  stop(): void {
    this.loop.stop();
  }

  /** One read; null when idle, netstat failed, or the interface changed mid-flight (prev kept). */
  async pollOnce(): Promise<CounterSample | null> {
    const iface = this.iface;
    if (iface === null) return null;
    const at = this.now();
    const r = await this.run([BIN.netstat, '-ib', '-I', iface], COUNTERS_TIMEOUT_MS);
    const c = r.ok ? parseNetstat(r.stdout, iface) : null;
    if (c === null || iface !== this.iface) return null;
    const { sample, dIn, dOut } = nextCounterSample(this.prev, { iface, ibytes: c.ibytes, obytes: c.obytes, at });
    this.prev = sample;
    this.sessionIn += dIn;
    this.sessionOut += dOut;
    if (!this.loop.stopped) this.onSample?.(sample, this.totals);
    return sample;
  }

  private async poll(): Promise<number> {
    await this.pollOnce();
    return COUNTERS_CADENCE_MS;
  }
}
