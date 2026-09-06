// §4.4 HTTPS cross-check against Cloudflare's trace endpoint.
import { BIN, CURL_UA, HTTPS_CADENCE_MS, HTTPS_MIN_GAP_MS, HTTPS_PROCESS_TIMEOUT_MS, HTTPS_TIMEOUT_S, HTTPS_URL } from '../config';
import { monoNow } from '../core/clock';
import { run as procRun } from '../core/proc';
import { envUrl } from './env';
import { parseCurlOut, parseHttpCode, secsToMs } from './http';
import type { HttpsKind, HttpsResult } from './types';
import type { RunFn, RunResult } from './run-types';

const HTTPS_FORMAT = '\\n@@|%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_total}';

export function buildHttpsArgs(): string[] {
  const url = envUrl('NETMON_HTTPS_URL', HTTPS_URL); // dev-only override
  return [BIN.curl, '-4', '-s', '-m', String(HTTPS_TIMEOUT_S), '-A', CURL_UA, '-o', '-', '-w', HTTPS_FORMAT, url];
}

/** exit 0 + 200 + `ip=` line → ok; exit 35/60 (TLS intercepted) or 3xx → portal; else fail. */
export function classifyHttps(exit: number | null, code: number | null, body: string): HttpsKind {
  if (exit === 0 && code === 200 && /^ip=/m.test(body)) return 'ok';
  if (exit === 35 || exit === 60) return 'portal';
  if (code !== null && code >= 300 && code < 400) return 'portal';
  return 'fail';
}

export function toHttpsResult(res: RunResult, startedAt: number): HttpsResult {
  const { body, fields } = parseCurlOut(res.stdout);
  const [codeS, , , , totalS] = fields;
  const code = parseHttpCode(codeS);
  const exitCode = res.err ? null : res.code;
  return { kind: classifyHttps(exitCode, code, body), code, exitCode, startedAt, ms: secsToMs(totalS) };
}

export type HttpsHandler = (r: HttpsResult) => void;

export interface HttpsPollerOpts {
  cadenceMs?: number; // default 180 s
  minGapMs?: number; // default 60 s for triggerNow
  now?: () => number;
}

/**
 * Runs at start, then every 180 s. `triggerNow()` (state leaves PORTAL/DOWN, or captive ok
 * while inetLink down and both resolvers fail) runs immediately when ≥ 60 s have passed since
 * the last start; otherwise it is deferred to the 60 s mark (one deferred run at most).
 */
export class HttpsPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handler: HttpsHandler | null = null;
  private inFlight = false;
  private pending = false;
  private lastStart = -Infinity;
  private nextAt = Infinity;
  private readonly cadenceMs: number;
  private readonly minGapMs: number;
  private readonly now: () => number;

  constructor(private readonly run: RunFn = procRun, opts: HttpsPollerOpts = {}) {
    this.cadenceMs = opts.cadenceMs ?? HTTPS_CADENCE_MS;
    this.minGapMs = opts.minGapMs ?? HTTPS_MIN_GAP_MS;
    this.now = opts.now ?? monoNow;
  }

  get running(): boolean {
    return this.handler !== null;
  }

  start(onResult: HttpsHandler): void {
    if (this.handler) return;
    this.handler = onResult;
    void this.fire();
  }

  stop(): void {
    this.handler = null;
    this.pending = false;
    this.clearTimer();
  }

  triggerNow(): void {
    if (!this.handler) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.scheduleAt(Math.max(this.now(), this.lastStart + this.minGapMs));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = Infinity;
  }

  /** Arm the timer for `at` unless an earlier run is already scheduled. */
  private scheduleAt(at: number): void {
    if (!this.handler || at >= this.nextAt) return;
    this.clearTimer();
    this.nextAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextAt = Infinity;
      void this.fire();
    }, Math.max(0, at - this.now()));
  }

  private async fire(): Promise<void> {
    if (this.inFlight || !this.handler) return;
    this.inFlight = true;
    this.clearTimer();
    const startedAt = this.now();
    this.lastStart = startedAt;
    const res = await this.run(buildHttpsArgs(), HTTPS_PROCESS_TIMEOUT_MS);
    this.inFlight = false;
    if (!this.handler) return;
    this.handler(toHttpsResult(res, startedAt));
    this.scheduleAt(startedAt + this.cadenceMs);
    if (this.pending) {
      this.pending = false;
      this.scheduleAt(startedAt + this.minGapMs);
    }
  }
}
