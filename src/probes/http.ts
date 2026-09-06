// §4.3 Captive-portal HTTP check: argv builder, `-w` output parser, classifier, poller.
import {
  BIN, CAPTIVE_DETECTORS, CURL_UA, DETECTOR_ORDER,
  HTTP_CADENCE_MS, HTTP_PROCESS_TIMEOUT_MS, HTTP_TIMEOUT_S,
} from '../config';
import { monoNow } from '../core/clock';
import { run as procRun } from '../core/proc';
import { envUrl } from './env';
import type { HttpDetector, HttpKind, HttpResult } from './types';
import type { RunFn, RunResult } from './run-types';

/** Marker curl prints (via `\n` in -w) between the body and the `|`-separated fields. */
export const CURL_MARKER = '\n@@|';
const CAPTIVE_FORMAT =
  '\\n@@|%{http_code}|%{redirect_url}|%{time_namelookup}|%{time_connect}|%{time_total}|%{size_download}';

/** The URL this detector probes: NETMON_CAPTIVE_URL (dev-only) or the §4.3 detector. */
export function captiveUrl(detector: HttpDetector): string {
  return envUrl('NETMON_CAPTIVE_URL', CAPTIVE_DETECTORS[detector]);
}

export function buildCaptiveArgs(detector: HttpDetector): string[] {
  return [
    BIN.curl, '-4', '-s', '-m', String(HTTP_TIMEOUT_S), '-A', CURL_UA, '-o', '-',
    '-w', CAPTIVE_FORMAT, captiveUrl(detector),
  ];
}

/** Split stdout on the LAST `\n@@|` → body, then the tail on `|` (§4.3). No marker → no fields. */
export function parseCurlOut(stdout: string): { body: string; fields: string[] } {
  const i = stdout.lastIndexOf(CURL_MARKER);
  if (i < 0) return { body: stdout, fields: [] };
  return { body: stdout.slice(0, i), fields: stdout.slice(i + CURL_MARKER.length).trimEnd().split('|') };
}

/** `%{http_code}` → number, or null for `000` / garbage. */
export function parseHttpCode(s: string | undefined): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** curl seconds field → integer ms, or null when unparseable. */
export function secsToMs(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

/** §4.3 table, rules applied in order. `redirectUrl` is kept by the caller, not used here. */
export function classifyCaptive(
  exitCode: number | null, detector: HttpDetector, code: number | null,
  body: string, _redirectUrl: string, sizeDownload: number,
): HttpKind {
  if (exitCode === 6) return 'dnsfail';
  if (exitCode !== 0) return 'fail';
  if (code !== null && ((code >= 300 && code < 400) || code === 511)) return 'portal';
  if (detector === 'apple') {
    if (code === 200) return body.includes('Success') ? 'ok' : 'portal';
    return 'fail';
  }
  if (code === 204 && sizeDownload === 0) return 'ok';
  if (code === 200) return 'portal';
  return 'fail';
}

/** Build the HttpResult from a finished curl run. Killed / spawn-failed runs classify as `fail`. */
export function toHttpResult(detector: HttpDetector, res: RunResult, startedAt: number): HttpResult {
  const { body, fields } = parseCurlOut(res.stdout);
  const [codeS, redirect = '', lookupS, connectS, totalS, sizeS] = fields;
  const code = parseHttpCode(codeS);
  const exitCode = res.err ? null : res.code;
  const kind = classifyCaptive(exitCode, detector, code, body, redirect, Number(sizeS) || 0);
  const connect = Number(connectS);
  const lookup = Number(lookupS);
  const connectMs = connect > 0 && Number.isFinite(lookup) ? Math.round((connect - lookup) * 1000) : null;
  // §4.3 table: only the 3xx/511 row substitutes the detector URL for a missing Location. A
  // 200-without-Success (apple) or 200 (google) portal is *weak* evidence and must keep an empty
  // redirectUrl, or §6.1's `strong` would be true for every portal and one result would flip
  // UP → PORTAL (the two-result rule would be dead).
  const strongCode = code !== null && ((code >= 300 && code < 400) || code === 511);
  const url = captiveUrl(detector);
  const portalUrl = kind === 'portal' ? redirect || (strongCode ? url : '') : '';
  return {
    kind, detector, url, code, exitCode, startedAt,
    ms: secsToMs(totalS), connectMs, redirectUrl: portalUrl || null,
  };
}

export type HttpHandler = (r: HttpResult) => void;

/**
 * Alternating-detector, single-flight poller (§4.3). Cadence is set by the store each tick
 * (10 s / 3 s); `triggerNow()` fires the out-of-band confirmation check (§6.2), queuing one
 * follow-up if a probe is already in flight.
 */
export class HttpPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handler: HttpHandler | null = null;
  private cadenceMs = HTTP_CADENCE_MS;
  private inFlight = false;
  private pending = false;
  private next = 0;
  private lastStart = -Infinity;
  private streak = 0;

  constructor(private readonly run: RunFn = procRun, private readonly now: () => number = monoNow) {}

  /** Consecutive `fail` results (§4.3). */
  get webFailStreak(): number {
    return this.streak;
  }

  get running(): boolean {
    return this.handler !== null;
  }

  start(onResult: HttpHandler): void {
    if (this.handler) return;
    this.handler = onResult;
    void this.fire();
  }

  stop(): void {
    this.handler = null;
    this.pending = false;
    this.clearTimer();
  }

  setCadence(ms: number): void {
    if (ms === this.cadenceMs) return;
    this.cadenceMs = ms;
    if (this.handler && !this.inFlight) this.scheduleNext();
  }

  triggerNow(): void {
    if (!this.handler) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.clearTimer();
    void this.fire();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.handler) return;
    const delay = Math.max(0, this.lastStart + this.cadenceMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    if (this.inFlight || !this.handler) return;
    this.inFlight = true;
    const detector: HttpDetector = DETECTOR_ORDER[this.next % DETECTOR_ORDER.length] ?? 'apple';
    this.next += 1;
    const startedAt = this.now();
    this.lastStart = startedAt;
    const res = await this.run(buildCaptiveArgs(detector), HTTP_PROCESS_TIMEOUT_MS);
    this.inFlight = false;
    if (!this.handler) return; // stopped while in flight
    const result = toHttpResult(detector, res, startedAt);
    this.streak = result.kind === 'fail' ? this.streak + 1 : 0;
    this.handler(result);
    if (this.pending) {
      this.pending = false;
      void this.fire();
      return;
    }
    this.scheduleNext();
  }
}
