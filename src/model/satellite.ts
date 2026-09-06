// §7.1 satellite mode: baseline-relative RTT thresholds. Pure.
import { SAT_P10_MS, SAT_CLEAR_MS, SAT_LOSS_MAX, SAT_OFFSET_BASE_MS, SAT_RECOMPUTE_MS } from '../config';
import { round50 } from '../core/stats';

export interface SatState {
  sat: boolean;
  rttOffset: number; // ms subtracted from p50/p95 while sat; 0 otherwise
  computedAt: number | null; // monotonic ms of the last offset computation
}

export const SAT_OFF: SatState = { sat: false, rttOffset: 0, computedAt: null };

/** `round50(max(0, p10 − 100))` */
export function satOffset(p10: number): number {
  return round50(Math.max(0, p10 - SAT_OFFSET_BASE_MS));
}

/**
 * One step of the satellite state machine. Pass `p10 = null` until ≥ 120 s of inet data
 * (§7.1) — a null p10 keeps the previous state. `now` is monotonic ms (recompute cadence).
 * Enter: p10 ≥ 400 && loss120 ≤ 2. Exit: p10 < 300. Offset recomputed every 60 s while on.
 */
export function updateSat(prev: SatState, p10: number | null, loss120: number | null, now = 0): SatState {
  if (p10 === null) return prev;
  if (prev.sat) {
    if (p10 < SAT_CLEAR_MS) return SAT_OFF;
    if (prev.computedAt !== null && now - prev.computedAt < SAT_RECOMPUTE_MS) return prev;
    return { sat: true, rttOffset: satOffset(p10), computedAt: now };
  }
  if (p10 >= SAT_P10_MS && loss120 !== null && loss120 <= SAT_LOSS_MAX) {
    return { sat: true, rttOffset: satOffset(p10), computedAt: now };
  }
  return prev;
}

/** `R = p50 − rttOffset` (floored at 0); null passes through. */
export function adjustRtt(ms: number | null, rttOffset: number): number | null {
  return ms === null ? null : Math.max(0, ms - rttOffset);
}
