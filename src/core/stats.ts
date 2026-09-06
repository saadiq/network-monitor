// Pure numeric helpers (§5). Percentiles are nearest-rank over sorted values.
import { MIN_RTTS_FOR_JITTER, MIN_SETTLED_FOR_LOSS } from '../config';

/** Nearest-rank percentile: rank = ceil(p/100 × n), clamped to 1..n. null when empty. */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1] ?? null;
}

/** Ascending copy. */
export function sortAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Nearest-rank p50 of an unsorted list (consistent with the displayed p50). null when empty. */
export function median(values: readonly number[]): number | null {
  return percentile(sortAsc(values), 50);
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Arithmetic mean; null when empty. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/** Mean |rtt_i − rtt_{i−1}| over consecutive received samples; null if fewer than 3. */
export function jitter(rtts: readonly number[]): number | null {
  if (rtts.length < MIN_RTTS_FOR_JITTER) return null;
  let acc = 0;
  for (let i = 1; i < rtts.length; i++) {
    acc += Math.abs((rtts[i] as number) - (rtts[i - 1] as number));
  }
  return acc / (rtts.length - 1);
}

export interface LossCounts { received: number; late: number; lost: number }

/** LOST / (RECEIVED + LATE + LOST) × 100; null if fewer than 3 settled samples. */
export function lossPct(c: LossCounts): number | null {
  const settled = c.received + c.late + c.lost;
  if (settled < MIN_SETTLED_FOR_LOSS) return null;
  return (c.lost / settled) * 100;
}

/** Round to the nearest 50 (§7.1 rttOffset). */
export function round50(x: number): number {
  return Math.round(x / 50) * 50 + 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
