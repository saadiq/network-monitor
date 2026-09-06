// §4.9 Opt-in 250 KB download test (keypress `t` only).
import { BIN, SPEED_MIN_BYTES, SPEED_MIN_GAP_MS, SPEED_PROCESS_TIMEOUT_MS, SPEED_TIMEOUT_S, SPEED_URL } from '../config';
import { run as procRun } from '../core/proc';
import type { State } from '../model/types';
import type { SpeedResult } from './types';
import type { RunFn } from './run-types';

const SPEED_FORMAT = '%{http_code}|%{size_download}|%{time_total}|%{speed_download}|%{time_starttransfer}';

export function buildSpeedArgs(): string[] {
  return [BIN.curl, '-4', '-s', '-m', String(SPEED_TIMEOUT_S), '-o', '/dev/null', '-w', SPEED_FORMAT, SPEED_URL];
}

function fail(why: string, bytes = 0, code: number | null = null, ms: number | null = null): SpeedResult {
  return { ok: false, downMbps: null, bytes, ms, code, why };
}

/** Shortest transfer phase worth dividing by; below this the quotient is timing noise. */
const MIN_TRANSFER_S = 0.01;

/**
 * Mbps of the *transfer phase*: `size_download / (time_total − time_starttransfer)`. curl's
 * `speed_download` divides by the whole wall time, so on a 250 KB burst the DNS/connect/TLS/TTFB
 * setup (often most of it) is counted as download time and understates the link several-fold.
 * Falls back to `speed_download` when no usable transfer phase was measured (§4.9).
 */
function downMbpsOf(bytes: number, total: number, startTransfer: number, speedDownload: number): number {
  const transferS = total - startTransfer;
  if (startTransfer > 0 && Number.isFinite(transferS) && transferS > MIN_TRANSFER_S) return (bytes * 8) / transferS / 1e6;
  return (speedDownload * 8) / 1e6;
}

/** ok = code 200 && size_download ≥ 200000 → downMbps from the transfer phase (small-burst estimate). */
export function parseSpeedOut(stdout: string, exit: number | null): SpeedResult {
  const fields = stdout.trim().split('|');
  if (fields.length < 4) return fail(exit === 28 ? 'timeout' : 'no output');
  const [codeS, sizeS, totalS, speedS, startS] = fields;
  const codeN = Number(codeS);
  const code = Number.isInteger(codeN) && codeN > 0 ? codeN : null;
  const bytes = Math.max(0, Math.floor(Number(sizeS))) || 0;
  const total = Number(totalS);
  const ms = Number.isFinite(total) ? Math.round(total * 1000) : null;
  if (code === 200 && bytes >= SPEED_MIN_BYTES) {
    const downMbps = downMbpsOf(bytes, total, Number(startS) || 0, Number(speedS) || 0);
    return { ok: true, downMbps, bytes, ms, code, why: null };
  }
  if (exit === 28) return fail('timeout', bytes, code, ms);
  if (exit !== 0) return fail(`curl exit ${exit ?? '?'}`, bytes, code, ms);
  if (code !== 200) return fail(`http ${code ?? '000'}`, bytes, code, ms);
  return fail(`partial ${Math.round(bytes / 1000)} KB`, bytes, code, ms);
}

/** Run the test through core/proc `run` (§9), injectable for tests. Never throws. */
export async function runSpeedTest(run: RunFn = procRun): Promise<SpeedResult> {
  const res = await run(buildSpeedArgs(), SPEED_PROCESS_TIMEOUT_MS);
  if (res.err) return fail('curl missing');
  const r = parseSpeedOut(res.stdout, res.code);
  if (!r.ok && res.timedOut) return { ...r, why: 'timeout' };
  return r;
}

/** Refuse while not UP/DEGRADED or within 30 s of the previous run (§4.9). */
export function canRun(now: number, last: number | null, state: State): { ok: boolean; why?: string } {
  if (state === 'WARMUP') return { ok: false, why: 'wait for the first verdict' }; // nothing is down yet
  if (state !== 'UP' && state !== 'DEGRADED') return { ok: false, why: 'no point testing while down' };
  if (last !== null && now - last < SPEED_MIN_GAP_MS) {
    const waitS = Math.ceil((SPEED_MIN_GAP_MS - (now - last)) / 1000);
    return { ok: false, why: `wait ${waitS}s between tests` };
  }
  return { ok: true };
}
