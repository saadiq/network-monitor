// Pure helpers over PingSample arrays (§5, §6.1). SampleWindow feeds these sorted samples.
import { LINK_DOWN_LOST, LINK_UP_RECEIVED, WIN_CAP_MS, WIN_FAST_MS, WIN_MAIN_MS } from '../config';
import { jitter as jitterOf, lossPct, percentile, sortAsc } from '../core/stats';
import type { PingSample, StreamStats } from '../probes/types';
import type { LinkState } from './types';

export const isSettled = (s: PingSample): boolean => s.state !== 'UNMEASURED';
export const isReceived = (s: PingSample): boolean => s.state === 'RECEIVED' || s.state === 'LATE';

/** Send-time order (= seq order within a generation; generations are sequential in time). */
export function bySendTime(a: PingSample, b: PingSample): number {
  return a.at - b.at || a.gen - b.gen || a.seq - b.seq;
}

interface Counts { received: number; late: number; lost: number; unmeasured: number }

function countStates(samples: readonly PingSample[], sinceAt: number): Counts {
  const c: Counts = { received: 0, late: 0, lost: 0, unmeasured: 0 };
  for (const s of samples) {
    if (s.at < sinceAt) continue;
    if (s.state === 'RECEIVED') c.received++;
    else if (s.state === 'LATE') c.late++;
    else if (s.state === 'LOST') c.lost++;
    else c.unmeasured++;
  }
  return c;
}

/**
 * §5 StreamStats for one window. `sorted` = every sample in send-time order; `idleOnly`
 * drops loaded samples (§4.8) from every metric, including the fixed loss windows.
 */
export function streamStats(sorted: readonly PingSample[], windowMs: number, idleOnly: boolean, now: number): StreamStats {
  const pool = idleOnly ? sorted.filter((s) => !s.loaded) : sorted;
  const sinceAt = now - windowMs;
  const c = countStates(pool, sinceAt);
  const rtts: number[] = [];
  for (const s of pool) if (s.at >= sinceAt && isReceived(s) && s.rttMs !== null) rtts.push(s.rttMs);
  const asc = sortAsc(rtts);
  return {
    windowMs,
    idleOnly,
    p50: percentile(asc, 50),
    p95: percentile(asc, 95),
    p10: percentile(asc, 10),
    jitter: jitterOf(rtts), // consecutive received in seq order; losses do not break pairs
    loss: lossPct(c),
    loss10: lossPct(countStates(pool, now - WIN_FAST_MS)),
    loss60: lossPct(countStates(pool, now - WIN_MAIN_MS)),
    loss300: lossPct(countStates(pool, now - WIN_CAP_MS)),
    received: c.received,
    late: c.late,
    lost: c.lost,
    unmeasured: c.unmeasured,
    settled: c.received + c.late + c.lost,
  };
}

export interface LinkFold {
  link: LinkState;
  downSince: number | null; // send time of the first LOST in the run that produced `down`
  upSince: number | null; // send time of the first RECEIVED/LATE of the run that produced `up`
}

/**
 * §6.1 hysteresis as a fold over settled samples in seq order: 3 consecutive LOST → down,
 * 2 consecutive RECEIVED/LATE → up, otherwise keep the previous state; < 2 settled → unknown.
 * Pure function of the ring, so a LATE flip retroactively repairs a lost run.
 */
export function foldLink(settled: readonly PingSample[]): LinkFold {
  let link: LinkState = 'unknown';
  let downSince: number | null = null;
  let upSince: number | null = null;
  let lostRun = 0;
  let recvRun = 0;
  let runStart = 0;
  for (const s of settled) {
    if (s.state === 'LOST') {
      if (lostRun === 0) runStart = s.at;
      lostRun++;
      recvRun = 0;
      if (lostRun >= LINK_DOWN_LOST && link !== 'down') {
        link = 'down';
        downSince = runStart;
        upSince = null;
      }
    } else {
      if (recvRun === 0) runStart = s.at;
      recvRun++;
      lostRun = 0;
      if (recvRun >= LINK_UP_RECEIVED && link !== 'up') {
        link = 'up';
        upSince = runStart;
        downSince = null;
      }
    }
  }
  return { link, downSince, upSince };
}

/** §5 blips: LOST runs of length 1–2 that ended with a reply and started at or after `sinceAt`. */
export function countBlips(settled: readonly PingSample[], sinceAt: number): number {
  let blips = 0;
  let lostRun = 0;
  let runStart = 0;
  for (const s of settled) {
    if (s.state === 'LOST') {
      if (lostRun === 0) runStart = s.at;
      lostRun++;
      continue;
    }
    if (lostRun >= 1 && lostRun <= 2 && runStart >= sinceAt) blips++;
    lostRun = 0;
  }
  return blips;
}

/** Last n settled samples oldest → newest: rtt, or null for LOST (UNMEASURED omitted). */
export function rttHistoryOf(sorted: readonly PingSample[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = sorted.length - 1; i >= 0 && out.length < n; i--) {
    const s = sorted[i] as PingSample;
    if (!isSettled(s)) continue;
    out.push(isReceived(s) ? s.rttMs : null);
  }
  return out.reverse();
}
