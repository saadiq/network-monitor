// Minimal Snapshot / UiState factory for the section tests, using the §8.1 mockup values.
import type { Snapshot, UiState } from '../src/model/types';
import { makeUi } from './helpers/snapshot';
import type { Signals } from '../src/model/types-snapshot';
import type { StreamStats } from '../src/probes/types';

const NOW = 1_124_000; // monotonic ms (run 18m44s)
const WALL = new Date(2026, 8, 6, 14, 32, 7).getTime(); // local 14:32:07

function stream(over: Partial<StreamStats>): StreamStats {
  return {
    windowMs: 60000, idleOnly: true, p50: null, p95: null, p10: null, jitter: null,
    loss: 0, loss10: 0, loss60: 0, loss300: 0, received: 58, late: 0, lost: 0, unmeasured: 0, settled: 58,
    ...over,
  };
}

const signals: Signals = {
  now: NOW, hasRoute: true, routeAt: NOW - 2000, assoc: 'yes', selfAssigned: false, rssi: -72, vpn: false,
  gwLink: 'up', inetLink: 'up', inetDownSince: null, gwDownSince: null, inetUpSince: null, gwUpSince: null,
  inetOk: true, icmpBlocked: false, gwNoIcmp: false, gwNoIcmpSince: null,
  portalSignal: false, portalSince: null,
  portalRedirectUrl: null, hasHttpResult: true, lastHttpKind: 'ok', httpAgeS: 4, httpStartedAt: NOW - 4000,
  lastHttpOkAt: NOW - 4000, dnsSysOk: true, dnsDirectOk: true, dnsOk: true, webFailStreak: 0, heldGrade: 'B',
  grace: false, graceUntil: null, gapMs: 1000,
};

export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    now: NOW, wall: WALL, startedAt: 0, startedWall: WALL - NOW, runS: 1124, gapMs: 1000,
    target: '1.1.1.1',
    route: {
      hasRoute: true, egressIface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', pingGateway: '192.168.0.1',
      ipv4: '192.168.0.42', selfAssigned: false, vpn: false, at: NOW - 2000,
    },
    vpn: false, missingBins: [], icmpBlocked: false, gwNoIcmp: false,
    gw: stream({ p50: 7, p95: 11, p10: 6, jitter: 2 }),
    inet: stream({ p50: 48, p95: 86, p10: 40, jitter: 71, loss60: 2, loss300: 4, lost: 1, settled: 59 }),
    inetP10_120: 40, latencyMs: 48, latencyP95: 86, latencySource: 'icmp', jitter: 71,
    loss10: 0, loss60: 2, loss300: 4, lossGrade: 2, lossSource: 'inet',
    late60: 0, blips: 1, unmeasured60: 0, errs: 0,
    rttHistory: [40, 48, null, 52, 210, 8],
    http: {
      kind: 'ok', detector: 'apple', url: 'http://captive.apple.com/hotspot-detect.html', code: 200, exitCode: 0,
      startedAt: NOW - 4000, ms: 310, connectMs: 48, redirectUrl: null, at: NOW - 4000, ageS: 4,
    },
    httpStale: false, https: null, rttProxyMs: 48, webFailStreak: 0,
    dnsDirect: { ok: true, ms: 31, server: '1.1.1.1', status: 'NOERROR', err: null, at: NOW - 9000, ageS: 9 },
    dnsSys: { ok: true, ms: 380, server: '100.100.100.100', status: 'NOERROR', err: null, at: NOW - 9000, ageS: 9 },
    dnsDirectOk: true, dnsSysOk: true, dnsOk: true, dnsServer: '100.100.100.100',
    wifi: {
      iface: 'en1', assoc: 'yes', ssid: null, rssi: -72, noise: -95, snr: 23, label: 'fair', txRate: 216, mcs: 4,
      channel: '157 (5GHz, 80MHz)', phy: '802.11ax', at: NOW - 28000, ageS: 28,
    },
    wifiStatus: 'ok',
    inKBs: 42, outKBs: 6, inHistory: [20, 30, 50, 20, 10, 10, 20, 30], outHistory: [1, 1, 2, 1, 1, 1, 1, 1],
    sessionIn: 38_200_000, sessionOut: 4_100_000, loadedNow: false, idleP50: 48, loadedP50: null,
    state: 'UP', cause: null, since: NOW - 252_000, sinceWall: WALL - 252_000, steadyFor: 252, downFor: null,
    grade: { grade: 'B', raw: 'B', tags: [], underLoad: false }, sat: false, rttOffset: 0,
    drops: {
      drops15: 3, drops60: 3, dropsSession: 3, dropMedianS: 22, dropLongestS: 64, dropUnder30: 2,
      dropGapS: 240, sinceLastDrop: 252, uptime15: 91, uptime60: 91,
    },
    outages: [], openOutage: null, timeline: () => [],
    trend: {
      latency: 'worse', loss: 'flat', overall: 'worse', phrase: 'getting worse',
      p50Last: 48, p50Prior: 30, lossLast: 2, lossPrior: 1,
    },
    speed: null, speedValid: false, probeBytes: 400_000, probeRateEst: 1_200_000,
    verdicts: [
      { name: 'CHAT', level: 'OK', reason: '' },
      { name: 'BROWSE', level: 'OK', reason: '' },
      { name: 'VIDEO CALL', level: 'SHAKY', reason: 'jitter 71ms · audio ok' },
      { name: 'DOWNLOAD', level: 'NO', reason: '3 drops/15m' },
    ],
    signals,
    tip: null,
    banner: [
      '● UP · OK (B) steady 4m12s getting worse 3 drops in 15m',
      'Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no (3 drops/15m).',
    ],
  };
  return { ...base, ...over };
}

export function ui(over: Partial<UiState> = {}): UiState {
  return makeUi({ view: 'advanced', ...over });
}
