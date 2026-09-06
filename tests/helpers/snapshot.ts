// Test factory: a complete, valid Snapshot with mockup (§8.1) defaults.
// Every field can be overridden; sub-factories build the nested records.
import type { Aged, Signals, Snapshot } from '../../src/model/types';
import type {
  ActivityName, CellState, DropStats, GradeInfo, Outage, Trend, Verdict,
} from '../../src/model/types';
import type {
  DnsResult, HttpResult, HttpsResult, RouteInfo, SpeedResult, StreamStats, WifiInfo,
} from '../../src/probes/types';

/** Mockup clock: 14:32:07 local, 18m44s into the session. */
export const T0_WALL = new Date(2026, 8, 6, 14, 32, 7).getTime();
export const RUN_S = 18 * 60 + 44;
export const NOW = RUN_S * 1000; // monotonic ms (process started at 0)
export const STARTED_WALL = T0_WALL - RUN_S * 1000;

/** Epoch ms for `HH:MM:SS` on the mockup day (local time). */
export function wallAt(hms: string): number {
  const [h, m, s] = hms.split(':').map(Number);
  return new Date(2026, 8, 6, h ?? 0, m ?? 0, s ?? 0).getTime();
}

export function makeStreamStats(o: Partial<StreamStats> = {}): StreamStats {
  return {
    windowMs: 60000, idleOnly: true, p50: 48, p95: 86, p10: 30, jitter: 71,
    loss: 2, loss10: 0, loss60: 2, loss300: 4,
    received: 58, late: 0, lost: 1, unmeasured: 0, settled: 59, ...o,
  };
}

export function makeGwStats(o: Partial<StreamStats> = {}): StreamStats {
  return makeStreamStats({
    p50: 7, p95: 11, p10: 5, jitter: 2, loss: 0, loss10: 0, loss60: 0, loss300: 0,
    received: 59, lost: 0, settled: 59, ...o,
  });
}

export function makeRoute(o: Partial<RouteInfo> = {}): RouteInfo {
  return {
    hasRoute: true, egressIface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1',
    pingGateway: '192.168.0.1', ipv4: '192.168.0.42', selfAssigned: false, vpn: false,
    at: NOW - 2000, ...o,
  };
}

export function makeWifi(o: Partial<Aged<WifiInfo>> = {}): Aged<WifiInfo> {
  return {
    iface: 'en1', assoc: 'yes', ssid: 'TestNet', rssi: -72, noise: -95, snr: 23,
    label: 'fair', txRate: 216, mcs: 4, channel: '157 (5GHz, 80MHz)', phy: '802.11ax',
    at: NOW - 28000, ageS: 28, ...o,
  };
}

export function makeHttp(o: Partial<Aged<HttpResult>> = {}): Aged<HttpResult> {
  return {
    kind: 'ok', detector: 'apple', url: 'http://captive.apple.com/hotspot-detect.html',
    code: 200, exitCode: 0, startedAt: NOW - 4000, ms: 310, connectMs: 120,
    redirectUrl: null, at: NOW - 4000, ageS: 4, ...o,
  };
}

export function makeHttps(o: Partial<Aged<HttpsResult>> = {}): Aged<HttpsResult> {
  return { kind: 'ok', code: 200, exitCode: 0, startedAt: NOW - 90000, ms: 420, at: NOW - 90000, ageS: 90, ...o };
}

export function makeDns(o: Partial<Aged<DnsResult>> = {}): Aged<DnsResult> {
  return { ok: true, ms: 31, server: '1.1.1.1', status: 'NOERROR', err: null, at: NOW - 5000, ageS: 5, ...o };
}

export function makeSpeed(o: Partial<Aged<SpeedResult>> = {}): Aged<SpeedResult> {
  return {
    ok: true, downMbps: 22.4, bytes: 250000, ms: 180, code: 200, why: null,
    at: NOW - 720000, ageS: 720, ...o,
  };
}

export function makeDrops(o: Partial<DropStats> = {}): DropStats {
  return {
    drops15: 3, drops60: 3, dropsSession: 3, dropMedianS: 22, dropLongestS: 64,
    dropUnder30: 2, dropGapS: 240, sinceLastDrop: 252, uptime15: 91, uptime60: 95, ...o,
  };
}

export const NO_DROPS: DropStats = {
  drops15: 0, drops60: 0, dropsSession: 0, dropMedianS: null, dropLongestS: null,
  dropUnder30: 0, dropGapS: null, sinceLastDrop: null, uptime15: 100, uptime60: 100,
};

export function makeGrade(o: Partial<GradeInfo> = {}): GradeInfo {
  return { grade: 'B', raw: 'B', tags: [], underLoad: false, ...o };
}

export function makeTrend(o: Partial<Trend> = {}): Trend {
  return {
    latency: 'worse', loss: 'flat', overall: 'worse', phrase: 'getting worse',
    p50Last: 48, p50Prior: 36, lossLast: 2, lossPrior: 1, ...o,
  };
}

export const FLAT_TREND: Trend = {
  latency: 'flat', loss: 'flat', overall: null, phrase: null,
  p50Last: 48, p50Prior: 47, lossLast: 2, lossPrior: 2,
};

/** Mockup verdicts; pass per-activity overrides. */
export function makeVerdicts(o: Partial<Record<ActivityName, Partial<Verdict>>> = {}): Verdict[] {
  const base: Verdict[] = [
    { name: 'CHAT', level: 'OK', reason: '' },
    { name: 'BROWSE', level: 'OK', reason: '' },
    { name: 'VIDEO CALL', level: 'SHAKY', reason: 'jitter 71ms · audio ok' },
    { name: 'DOWNLOAD', level: 'NO', reason: '3 drops/15m' },
  ];
  return base.map((v) => ({ ...v, ...(o[v.name] ?? {}) }));
}

export function allOkVerdicts(): Verdict[] {
  return makeVerdicts({ 'VIDEO CALL': { level: 'OK', reason: '' }, DOWNLOAD: { level: 'OK', reason: 'untested (t)' } });
}

export function makeOutage(o: Partial<Outage> = {}): Outage {
  const startedAt = o.startedAt ?? wallAt('14:27:55');
  const durationS = o.durationS ?? 22;
  return {
    n: 1, state: 'DOWN', cause: 'uplink', startedAt, endedAt: startedAt + durationS * 1000,
    durationS, sleep: false, ...o,
  };
}

/** The three drops of the §8.1 mockup, newest first. */
export function mockupOutages(): Outage[] {
  return [
    makeOutage({ n: 3, state: 'DOWN', cause: 'uplink', startedAt: wallAt('14:27:55'), durationS: 22 }),
    makeOutage({ n: 2, state: 'PORTAL', cause: 'portal', startedAt: wallAt('14:21:10'), durationS: 64 }),
    makeOutage({ n: 1, state: 'DOWN', cause: 'wifi', startedAt: wallAt('14:19:02'), durationS: 9 }),
  ];
}

export function makeSignals(o: Partial<Signals> = {}): Signals {
  return {
    now: NOW, hasRoute: true, routeAt: NOW - 2000, assoc: 'yes', selfAssigned: false,
    rssi: -72, vpn: false, gwLink: 'up', inetLink: 'up', inetDownSince: null, gwDownSince: null,
    inetUpSince: null, gwUpSince: null, inetOk: true, icmpBlocked: false,
    gwNoIcmp: false, gwNoIcmpSince: null,
    portalSignal: false, portalSince: null, portalRedirectUrl: null, hasHttpResult: true,
    lastHttpKind: 'ok', httpAgeS: 4, httpStartedAt: NOW - 4000, lastHttpOkAt: NOW - 4000,
    dnsSysOk: true, dnsDirectOk: true, dnsOk: true, webFailStreak: 0, heldGrade: 'B',
    grace: false, graceUntil: null, gapMs: 1000, ...o,
  };
}

const upTimeline = (cells: number): CellState[] => Array.from({ length: cells }, () => 'UP' as CellState);

/** A full, valid Snapshot: UP (B), steady 4m12s, mockup metrics and drops. */
export function makeSnapshot(o: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    now: NOW, wall: T0_WALL, startedAt: 0, startedWall: STARTED_WALL, runS: RUN_S, gapMs: 1000,
    target: '1.1.1.1', route: makeRoute(), vpn: false, missingBins: [],
    icmpBlocked: false, gwNoIcmp: false,
    gw: makeGwStats(), inet: makeStreamStats(), inetP10_120: 30,
    latencyMs: 48, latencyP95: 86, latencySource: 'icmp', jitter: 71,
    loss10: 0, loss60: 2, loss300: 4, lossGrade: 2, lossSource: 'inet',
    late60: 0, blips: 1, unmeasured60: 0, errs: 0,
    rttHistory: Array.from({ length: 60 }, (_, i) => 40 + (i % 7) * 3),
    http: makeHttp(), httpStale: false, https: makeHttps(), rttProxyMs: 120, webFailStreak: 0,
    dnsDirect: makeDns(), dnsSys: makeDns({ ms: 380, server: '100.100.100.100' }),
    dnsDirectOk: true, dnsSysOk: true, dnsOk: true, dnsServer: '100.100.100.100',
    wifi: makeWifi(), wifiStatus: 'ok',
    inKBs: 42, outKBs: 6, inHistory: [12, 20, 35, 18, 9, 8, 15, 22, 30, 42],
    outHistory: [3, 4, 6, 4, 3, 3, 4, 5, 6, 6], sessionIn: 38_200_000, sessionOut: 4_100_000,
    loadedNow: false, idleP50: 48, loadedP50: null,
    state: 'UP', cause: null, since: NOW - 252_000, sinceWall: T0_WALL - 252_000,
    steadyFor: 252, downFor: null,
    grade: makeGrade(), sat: false, rttOffset: 0,
    drops: makeDrops(), outages: mockupOutages(), openOutage: null, timeline: upTimeline,
    trend: makeTrend(),
    speed: makeSpeed(), speedValid: false, probeBytes: 400_000, probeRateEst: 1_200_000,
    verdicts: makeVerdicts(), signals: makeSignals(), tip: null, banner: ['', ''],
  };
  const snap = { ...base, ...o };
  // §7.2: lossGrade is the grade's loss input. A caller that only overrides loss60 means "this
  // much loss" for the grade too, so mirror it unless the test pins lossGrade itself.
  if (o.lossGrade === undefined) snap.lossGrade = snap.loss60;
  return snap;
}
