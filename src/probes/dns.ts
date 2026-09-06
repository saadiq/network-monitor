// §4.5 DNS: dig argv, `+stats` parser, name rotation, 15 s poller (system + direct).
import {
  BIN, DNS_CACHEBUSTER_DOMAIN, DNS_CACHEBUSTER_EVERY, DNS_CADENCE_MS, DNS_DIRECT_SERVER,
  DNS_NAMES, DNS_PROCESS_TIMEOUT_MS, DNS_TIMEOUT_S,
} from '../config';
import { monoNow } from '../core/clock';
import { run as procRun } from '../core/proc';
import { envServer } from './env';
import type { DnsErr, DnsPair, DnsResult } from './types';
import type { RunFn, RunResult } from './run-types';

/** The §4.5 direct resolver, or NETMON_DNS_SERVER (dev-only). */
export function directServer(): string {
  return envServer('NETMON_DNS_SERVER', DNS_DIRECT_SERVER);
}

export function buildDigArgs(name: string, server?: string): string[] {
  const argv = [BIN.dig, `+time=${DNS_TIMEOUT_S}`, '+tries=1', '+noall', '+comments', '+stats', name, 'A'];
  if (server) argv.push(`@${server}`);
  return argv;
}

function failed(err: DnsErr, status: string | null = null, ms: number | null = null, server: string | null = null): DnsResult {
  return { ok: false, ms, server, status, err };
}

/** §4.5: ok = exit 0 && NOERROR|NXDOMAIN; ms from `Query time` (never wall time). */
export function parseDig(stdout: string, exit: number | null): DnsResult {
  if (exit === 9 || stdout.includes('connection timed out')) return failed('TIMEOUT');
  const status = /status: ([A-Z]+)/.exec(stdout)?.[1] ?? null;
  const msS = /Query time: (\d+) msec/.exec(stdout)?.[1];
  const ms = msS === undefined ? null : Number(msS);
  const server = /SERVER: ([\d.:a-f]+)#/.exec(stdout)?.[1] ?? null;
  if (exit !== 0 || status === null) return failed('PROBE_ERROR', status, ms, server);
  if (status === 'NOERROR' || status === 'NXDOMAIN') return { ok: true, ms, server, status, err: null };
  return failed('DNS_ERROR', status, ms, server); // SERVFAIL / REFUSED / …
}

/** Wrap a finished run: spawn failure → PROBE_ERROR, process kill → TIMEOUT, else parseDig. */
export function digResult(res: RunResult): DnsResult {
  if (res.err) return failed('PROBE_ERROR');
  if (res.timedOut) return failed('TIMEOUT');
  return parseDig(res.stdout, res.code);
}

function randomHex8(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Round r (0-based) → name. Every 4th round (r % 4 === 3) is `<8 hex>.example.com`; the other
 * rounds cycle apple → cloudflare → google. `hex8` overrides the random label (tests).
 */
export function nextName(round: number, hex8?: string): string {
  const r = Math.max(0, Math.floor(round));
  if ((r + 1) % DNS_CACHEBUSTER_EVERY === 0) return `${hex8 ?? randomHex8()}.${DNS_CACHEBUSTER_DOMAIN}`;
  const normal = r - Math.floor(r / DNS_CACHEBUSTER_EVERY);
  return DNS_NAMES[normal % DNS_NAMES.length] ?? DNS_NAMES[0] ?? 'www.apple.com';
}

export type DnsPairHandler = (pair: DnsPair) => void;

export interface DnsPollerOpts {
  cadenceMs?: number; // default 15 s
  now?: () => number;
}

/** Every 15 s: system-path and @1.1.1.1 digs for the same name, concurrently (allSettled). */
export class DnsPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handler: DnsPairHandler | null = null;
  private inFlight = false;
  private round = 0;
  private readonly cadenceMs: number;
  private readonly now: () => number;

  constructor(private readonly run: RunFn = procRun, opts: DnsPollerOpts = {}) {
    this.cadenceMs = opts.cadenceMs ?? DNS_CADENCE_MS;
    this.now = opts.now ?? monoNow;
  }

  get running(): boolean {
    return this.handler !== null;
  }

  start(onPair: DnsPairHandler): void {
    if (this.handler) return;
    this.handler = onPair;
    void this.fire();
  }

  stop(): void {
    this.handler = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async fire(): Promise<void> {
    if (this.inFlight || !this.handler) return;
    this.inFlight = true;
    const name = nextName(this.round);
    this.round += 1;
    const at = this.now();
    const [sys, direct] = await Promise.allSettled([
      this.run(buildDigArgs(name), DNS_PROCESS_TIMEOUT_MS),
      this.run(buildDigArgs(name, directServer()), DNS_PROCESS_TIMEOUT_MS),
    ]);
    this.inFlight = false;
    if (!this.handler) return;
    this.handler({ name, sys: settled(sys), direct: settled(direct), at });
    if (!this.handler) return;
    const delay = Math.max(0, at + this.cadenceMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delay);
  }
}

function settled(r: PromiseSettledResult<RunResult>): DnsResult {
  return r.status === 'fulfilled' ? digResult(r.value) : failed('PROBE_ERROR');
}
