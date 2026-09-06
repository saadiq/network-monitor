// §7.3 trend: last 60 s vs prior 60 s of the inet stream. Pure.
import {
  TREND_MIN_SAMPLES, TREND_WORSE_RATIO, TREND_BETTER_RATIO, TREND_MIN_DELTA_MS, TREND_LOSS_DELTA,
  WIN_MAIN_MS, IDLE_MIN_SAMPLES,
} from '../config';
import { median, lossPct } from '../core/stats';
import type { PingSample, StreamStats } from '../probes/types';
import type { Trend, TrendDir } from './types';

/** One 60 s half. A StreamStats is assignable; `received + late` must be ≥ 10 for a trend. */
export type TrendHalf = Pick<StreamStats, 'p50' | 'loss' | 'received' | 'late'>;

export const NO_TREND: Trend = {
  latency: null, loss: null, overall: null, phrase: null,
  p50Last: null, p50Prior: null, lossLast: null, lossPrior: null,
};

function hasRtt(s: PingSample): boolean {
  return (s.state === 'RECEIVED' || s.state === 'LATE') && s.rttMs !== null;
}

/** Summarise settled samples of one half; idle samples preferred when ≥ 10 idle received (§4.8). */
export function trendHalf(samples: readonly PingSample[]): TrendHalf {
  const idle = samples.filter((s) => !s.loaded);
  const use = idle.filter(hasRtt).length >= IDLE_MIN_SAMPLES ? idle : samples;
  let received = 0;
  let late = 0;
  let lost = 0;
  const rtts: number[] = [];
  for (const s of use) {
    if (s.state === 'RECEIVED') received++;
    else if (s.state === 'LATE') late++;
    else if (s.state === 'LOST') lost++;
    if (hasRtt(s)) rtts.push(s.rttMs as number);
  }
  return { p50: median(rtts), loss: lossPct({ received, late, lost }), received, late };
}

function latencyDir(last: number | null, prior: number | null): TrendDir {
  if (last === null || prior === null) return null;
  if (last >= TREND_WORSE_RATIO * prior && last - prior >= TREND_MIN_DELTA_MS) return 'worse';
  if (last <= TREND_BETTER_RATIO * prior && prior - last >= TREND_MIN_DELTA_MS) return 'better';
  return 'flat';
}

function lossDir(last: number | null, prior: number | null): TrendDir {
  if (last === null || prior === null) return null;
  if (last - prior >= TREND_LOSS_DELTA) return 'worse';
  if (prior - last >= TREND_LOSS_DELTA) return 'better';
  return 'flat';
}

/** §7.3: both halves need ≥ 10 received (RECEIVED + LATE) samples, else no trend. */
export function computeTrend(last: TrendHalf, prior: TrendHalf): Trend {
  const values = { p50Last: last.p50, p50Prior: prior.p50, lossLast: last.loss, lossPrior: prior.loss };
  const enough = (h: TrendHalf): boolean => h.received + h.late >= TREND_MIN_SAMPLES;
  if (!enough(last) || !enough(prior)) return { ...NO_TREND, ...values };
  const latency = latencyDir(last.p50, prior.p50);
  const loss = lossDir(last.loss, prior.loss);
  const anyWorse = latency === 'worse' || loss === 'worse';
  const anyBetter = latency === 'better' || loss === 'better';
  const overall = anyWorse && !anyBetter ? 'worse' : anyBetter && !anyWorse ? 'better' : null;
  const phrase = overall === 'worse' ? 'getting worse' : overall === 'better' ? 'improving' : null;
  return { latency, loss, overall, phrase, ...values };
}

/** Split samples by send time into [now−2h, now−h) and [now−h, now] halves, then computeTrend. */
export function trendFromSamples(samples: readonly PingSample[], now: number, halfMs = WIN_MAIN_MS): Trend {
  const lastFrom = now - halfMs;
  const priorFrom = now - 2 * halfMs;
  const last: PingSample[] = [];
  const prior: PingSample[] = [];
  for (const s of samples) {
    if (s.at > now) continue;
    if (s.at >= lastFrom) last.push(s);
    else if (s.at >= priorFrom) prior.push(s);
  }
  return computeTrend(trendHalf(last), trendHalf(prior));
}
