// §5 Snapshot builder. Runs after Store.tick() has advanced the streams and the state machine;
// fills every field in order: streams → probes → traffic → grade/sat → outages → trend →
// verdicts → tip → banner. Pure apart from the grade hold and satellite state it advances.
import {
  GRADE_LOSS_TIER_SETTLED, GRADE_MIN_SETTLED_FOR_LOSS, GRADE_SHORT_RUN_LOSS_CAP,
  HTTP_STALE_MS, IDLE_MIN_SAMPLES, LOADED_KBS, LOADED_SPEED_WINDOW_MS, RTT_HISTORY_N,
  SAT_MIN_DATA_MS, SPEED_VALID_MS, WIFI_STALE_MS, WIN_CAP_MS, WIN_MAIN_MS, WIN_TREND_MS,
} from '../config';
import { median } from '../core/stats';
import type { StreamStats } from '../probes/types';
import { bannerLines } from './banner-text';
import { computeGrade, gradeInputs, type CapContext } from './grade';
import type { SampleWindow } from './samples';
import { updateSat } from './satellite';
import type { Store } from './store';
import { pickTip } from './tips';
import { trendFromSamples } from './trend';
import type { DropStats, Signals, Snapshot } from './types';
import { activityVerdicts } from './verdicts';

/** Counter samples older than this are not "this second" (poller stalled or paused). */
const COUNTER_FRESH_MS = 3000;

/** §4.8: idle samples when ≥ 10 idle received in the window; otherwise all samples (`~` only when some were loaded). */
export function pickStats(win: SampleWindow, now: number, windowMs = WIN_MAIN_MS): StreamStats {
  const idle = win.stats(windowMs, true, now);
  if (idle.received + idle.late >= IDLE_MIN_SAMPLES) return idle;
  const all = win.stats(windowMs, false, now);
  const total = (s: StreamStats): number => s.settled + s.unmeasured;
  return total(all) > total(idle) ? all : { ...all, idleOnly: true };
}

/** Stamp a timed result with its age in seconds. */
export function aged<T extends { at: number }>(v: T | null, now: number): (T & { ageS: number }) | null {
  return v === null ? null : { ...v, ageS: Math.max(0, (now - v.at) / 1000) };
}

type StreamFields = Pick<
  Snapshot,
  'gw' | 'inet' | 'inetP10_120' | 'latencyMs' | 'latencyP95' | 'latencySource' | 'jitter' | 'loss10' | 'loss60'
  | 'loss300' | 'lossSource' | 'late60' | 'blips' | 'unmeasured60' | 'errs' | 'rttHistory' | 'rttProxyMs'
>;

/** §5 stream metrics; effective latency/loss follow the ICMP-blocked source rule (§6.1). */
function streamFields(store: Store, now: number, icmpBlocked: boolean, inet120: StreamStats): StreamFields {
  const gw = pickStats(store.gwWin, now);
  const inet = pickStats(store.inetWin, now);
  const inetAll = store.inetWin.stats(WIN_MAIN_MS, false, now);
  const rttProxyMs = store.http?.connectMs ?? null;
  const src = icmpBlocked ? gw : inet;
  return {
    gw,
    inet,
    inetP10_120: inet120.p10,
    latencyMs: icmpBlocked ? rttProxyMs : inet.p50,
    latencyP95: icmpBlocked ? null : inet.p95,
    latencySource: icmpBlocked ? 'http' : 'icmp',
    jitter: src.jitter,
    loss10: src.loss10,
    loss60: src.loss60,
    loss300: src.loss300,
    lossSource: icmpBlocked ? 'router' : 'inet',
    late60: inetAll.late,
    blips: store.inetWin.blips(WIN_MAIN_MS, now),
    unmeasured60: inetAll.unmeasured,
    errs: store.inetWin.errs + store.gwWin.errs + store.probeErrs,
    rttHistory: store.inetWin.rttHistory(RTT_HISTORY_N),
    rttProxyMs,
  };
}

type ProbeFields = Pick<
  Snapshot,
  'http' | 'httpStale' | 'https' | 'webFailStreak' | 'dnsDirect' | 'dnsSys' | 'dnsDirectOk' | 'dnsSysOk'
  | 'dnsOk' | 'dnsServer' | 'wifi' | 'wifiStatus'
>;

function probeFields(store: Store, now: number, sig: Signals): ProbeFields {
  const h = store.http;
  const http = h ? aged({ ...h, at: h.startedAt }, now) : null;
  const hs = store.https;
  const pair = store.dns;
  const wifi = store.wifiEnabled ? aged(store.wifi, now) : null;
  let wifiStatus: Snapshot['wifiStatus'] = 'off';
  if (store.wifiEnabled) wifiStatus = wifi === null ? 'reading' : wifi.ageS * 1000 > WIFI_STALE_MS ? 'stale' : 'ok';
  return {
    http,
    httpStale: http !== null && http.ageS * 1000 > HTTP_STALE_MS,
    https: hs ? aged({ ...hs, at: hs.startedAt }, now) : null,
    webFailStreak: store.webFailStreak,
    dnsDirect: pair ? aged({ ...pair.direct, at: pair.at }, now) : null,
    dnsSys: pair ? aged({ ...pair.sys, at: pair.at }, now) : null,
    dnsDirectOk: sig.dnsDirectOk,
    dnsSysOk: sig.dnsSysOk,
    dnsOk: sig.dnsOk,
    dnsServer: store.dnsServer,
    wifi,
    wifiStatus,
  };
}

type TrafficFields = Pick<
  Snapshot,
  'inKBs' | 'outKBs' | 'inHistory' | 'outHistory' | 'sessionIn' | 'sessionOut' | 'loadedNow' | 'idleP50' | 'loadedP50'
>;

function trafficFields(store: Store, now: number): TrafficFields {
  const c = store.counters;
  const fresh = c !== null && now - c.at <= COUNTER_FRESH_MS;
  const inKBs = fresh ? c.inKBs : null;
  const outKBs = fresh ? c.outKBs : null;
  const speedLoaded = store.speedStartedAt !== null
    && (store.speedEndedAt === null || now - store.speedEndedAt <= LOADED_SPEED_WINDOW_MS);
  const loadedRtts: number[] = [];
  for (const s of store.inetWin.samples()) {
    if (s.loaded && s.at >= now - WIN_MAIN_MS && s.rttMs !== null && s.state !== 'LOST') loadedRtts.push(s.rttMs);
  }
  return {
    inKBs,
    outKBs,
    inHistory: [...store.inHistory],
    outHistory: [...store.outHistory],
    sessionIn: store.totals.sessionIn,
    sessionOut: store.totals.sessionOut,
    loadedNow: speedLoaded || (inKBs ?? 0) + (outKBs ?? 0) > LOADED_KBS,
    idleP50: store.inetWin.stats(WIN_MAIN_MS, true, now).p50,
    loadedP50: median(loadedRtts),
  };
}

type GradeFields = Pick<Snapshot, 'grade' | 'sat' | 'rttOffset' | 'lossGrade'>;

/**
 * §7.2/§7.4 loss inputs: loss over the current steady run only (60 s for the tier, 300 s for the
 * cap). A closed outage's own LOST samples stay in loss60/loss300 (the metrics row) but must not
 * hold the grade — and with it the verdicts — at C/D once the link is clean again; the outage
 * itself is already priced in by the recent-drop and FLAKY caps.
 */
function steadyLoss(store: Store, now: number, drops: DropStats, icmpBlocked: boolean): { tier: number | null; cap: number | null } {
  const runMs = drops.sinceLastDrop === null ? Infinity : drops.sinceLastDrop * 1000;
  const win = icmpBlocked ? store.gwWin : store.inetWin;
  const loss = (windowMs: number): number | null => {
    const st = pickStats(win, now, Math.max(1, Math.min(windowMs, runMs)));
    if (st.settled < GRADE_MIN_SETTLED_FOR_LOSS || st.loss === null) return null;
    // a young run is a short window: one lost packet is 5–10 % of it, which is not "C/D bad"
    return st.settled < GRADE_LOSS_TIER_SETTLED ? Math.min(st.loss, GRADE_SHORT_RUN_LOSS_CAP) : st.loss;
  };
  return { tier: loss(WIN_MAIN_MS), cap: loss(WIN_CAP_MS) };
}

/** §7.1 satellite step (needs ≥ 120 s of inet data) then §7.2 grade with caps and hold. */
function gradeFields(store: Store, now: number, st: StreamFields, drops: DropStats, inet120: StreamStats): GradeFields {
  const oldest = store.inetWin.samples()[0];
  const dataMs = oldest ? now - oldest.at : 0;
  store.sat = updateSat(store.sat, dataMs >= SAT_MIN_DATA_MS ? inet120.p10 : null, inet120.loss, now);
  const icmpBlocked = st.latencySource === 'http';
  const steady = steadyLoss(store, now, drops, icmpBlocked);
  const inputs = gradeInputs({
    inet: { ...st.inet, loss60: steady.tier }, gw: { ...st.gw, loss60: steady.tier },
    icmpBlocked, rttProxyMs: st.rttProxyMs, rttOffset: store.sat.rttOffset,
  });
  const ctx: CapContext = {
    sinceLastDrop: drops.sinceLastDrop, drops15: drops.drops15, loss300: steady.cap, icmpBlocked,
    underLoad: !st.inet.idleOnly,
  };
  return {
    grade: computeGrade(inputs, ctx, store.hold, store.status.state),
    sat: store.sat.sat,
    rttOffset: store.sat.rttOffset,
    lossGrade: steady.tier,
  };
}

/** §5: every Snapshot field for this tick. Call once per tick (it advances the grade hold). */
export function computeSnapshot(store: Store, now: number): Snapshot {
  const sig = store.sig;
  const eff = store.effNow(now); // §6.3 outage/timeline clock: sleep-aware
  const inet120 = store.inetWin.stats(WIN_TREND_MS, false, now);
  const st = streamFields(store, now, sig.icmpBlocked, inet120);
  const drops = store.tracker.stats(eff);
  const speed = aged(store.speed, now);
  const snap: Snapshot = {
    now,
    wall: store.wall,
    startedAt: store.startedAt,
    startedWall: store.startedWall,
    runS: Math.max(0, Math.floor((now - store.startedAt) / 1000)),
    gapMs: store.gapMs,
    target: store.target,
    route: store.route,
    vpn: store.route?.vpn ?? false,
    missingBins: [...store.missingBins],
    icmpBlocked: sig.icmpBlocked,
    gwNoIcmp: sig.gwNoIcmp,
    ...st,
    ...probeFields(store, now, sig),
    ...trafficFields(store, now),
    state: store.status.state,
    cause: store.status.cause,
    since: store.status.since,
    sinceWall: store.status.sinceWall,
    steadyFor: Math.max(0, (eff - store.steadyAt) / 1000),
    downFor: store.tracker.open?.durationS ?? null,
    ...gradeFields(store, now, st, drops, inet120),
    drops,
    outages: store.tracker.outages(),
    openOutage: store.tracker.open,
    timeline: (cells, cellMs) => store.tracker.timeline(eff, cells, cellMs),
    trend: trendFromSamples(store.inetWin.settled(now - WIN_TREND_MS), now),
    speed,
    speedValid: speed !== null && speed.ageS * 1000 <= SPEED_VALID_MS,
    probeBytes: store.budget.total,
    probeRateEst: store.budget.perHourEstimate,
    verdicts: [],
    signals: sig,
    tip: null,
    banner: ['', ''],
  };
  snap.verdicts = activityVerdicts(snap, store.glyphs);
  snap.tip = pickTip(snap, store.glyphs);
  snap.banner = bannerLines(snap, store.glyphs);
  return snap;
}
