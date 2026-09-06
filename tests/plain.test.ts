import { test, expect } from 'bun:test';
import { renderPlainLine, renderPlainEvent } from '../src/ui/plain';
import type { Snapshot, Outage, Transition, Verdict } from '../src/model/types';
import type { StreamStats } from '../src/probes/types';

// Local minimal factory (tests/helpers/snapshot.ts did not exist when this was written).
const WALL = new Date(2026, 8, 6, 14, 32, 7).getTime(); // local 14:32:07
const NOW = 1_124_000; // mono ms, run 18m44s

function stats(o: Partial<StreamStats>): StreamStats {
  return {
    windowMs: 60000, idleOnly: true, p50: null, p95: null, p10: null, jitter: null, loss: null,
    loss10: null, loss60: null, loss300: null, received: 0, late: 0, lost: 0, unmeasured: 0, settled: 0, ...o,
  };
}

const VERDICTS: Verdict[] = [
  { name: 'CHAT', level: 'OK', reason: '' },
  { name: 'BROWSE', level: 'OK', reason: '' },
  { name: 'VIDEO CALL', level: 'SHAKY', reason: 'jitter 71ms · audio ok' },
  { name: 'DOWNLOAD', level: 'NO', reason: '3 drops/15m' },
];

function makeSnapshot(o: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    now: NOW, wall: WALL, startedAt: 0, startedWall: WALL - NOW, runS: 1124, gapMs: 1000,
    target: '1.1.1.1', route: null, vpn: false, missingBins: [], icmpBlocked: false, gwNoIcmp: false,
    gw: stats({ p50: 7, p95: 11, loss10: 0, loss60: 0 }),
    inet: stats({ p50: 48, p95: 86, jitter: 71, loss10: 0, loss60: 2, loss300: 4 }),
    inetP10_120: 40, latencyMs: 48, latencyP95: 86, latencySource: 'icmp', jitter: 71,
    loss10: 0, loss60: 2, loss300: 4, lossGrade: 2, lossSource: 'inet',
    late60: 0, blips: 1, unmeasured60: 0, errs: 0,
    rttHistory: [],
    http: { kind: 'ok', detector: 'apple', url: 'http://captive.apple.com/hotspot-detect.html', code: 200, exitCode: 0, startedAt: NOW - 3000, ms: 310, connectMs: 120, redirectUrl: null, at: NOW - 3000, ageS: 3 },
    httpStale: false, https: null, rttProxyMs: 120, webFailStreak: 0,
    dnsDirect: { ok: true, ms: 31, server: '1.1.1.1', status: 'NOERROR', err: null, at: NOW - 5000, ageS: 5 },
    dnsSys: { ok: true, ms: 380, server: '100.100.100.100', status: 'NOERROR', err: null, at: NOW - 5000, ageS: 5 },
    dnsDirectOk: true, dnsSysOk: true, dnsOk: true, dnsServer: '100.100.100.100',
    wifi: { iface: 'en1', assoc: 'yes', ssid: null, rssi: -72, noise: -95, snr: 23, label: 'fair', txRate: 216, mcs: 4, channel: '157 (5GHz, 80MHz)', phy: '802.11ax', at: NOW - 28000, ageS: 28 },
    wifiStatus: 'ok',
    inKBs: 42, outKBs: 6, inHistory: [], outHistory: [], sessionIn: 38_200_000, sessionOut: 4_100_000,
    loadedNow: false, idleP50: 48, loadedP50: null,
    state: 'UP', cause: null, since: NOW - 252_000, sinceWall: WALL - 252_000, steadyFor: 252, downFor: null,
    grade: { grade: 'B', raw: 'B', tags: [], underLoad: false }, sat: false, rttOffset: 0,
    drops: { drops15: 3, drops60: 3, dropsSession: 3, dropMedianS: 22, dropLongestS: 64, dropUnder30: 2, dropGapS: 240, sinceLastDrop: 252, uptime15: 91, uptime60: 95 },
    outages: [], openOutage: null, timeline: () => [],
    trend: { latency: 'worse', loss: 'flat', overall: 'worse', phrase: 'getting worse', p50Last: 48, p50Prior: 30, lossLast: 2, lossPrior: 1 },
    speed: null, speedValid: false, probeBytes: 400_000, probeRateEst: 1_200_000,
    verdicts: VERDICTS,
    signals: {
      now: NOW, hasRoute: true, routeAt: NOW - 2000, assoc: 'yes', selfAssigned: false, rssi: -72, vpn: false,
      gwLink: 'up', inetLink: 'up', inetDownSince: null, gwDownSince: null, inetUpSince: null, gwUpSince: null,
      inetOk: true, icmpBlocked: false, gwNoIcmp: false, gwNoIcmpSince: null,
      portalSignal: false, portalSince: null, portalRedirectUrl: null,
      hasHttpResult: true, lastHttpKind: 'ok', httpAgeS: 3, httpStartedAt: NOW - 3000, lastHttpOkAt: NOW - 3000,
      dnsSysOk: true, dnsDirectOk: true, dnsOk: true, webFailStreak: 0, heldGrade: 'B', grace: false, graceUntil: null, gapMs: 1000,
    },
    tip: null, banner: ['● UP · OK (B)', 'Fine for chat & browsing.'],
  };
  return { ...base, ...o };
}

test('renders the §8.5 sample line exactly', () => {
  expect(renderPlainLine(makeSnapshot())).toBe(
    '14:32:07 UP B steady 4m12s | gw 7ms 0% | inet p50 48 p95 86 jit 71 loss 2% | dns 31/380 | http ok 0.31s | wifi -72 | in 42K out 6K | CHAT OK BROWSE OK VIDEO SHAKY DOWNLOAD NO',
  );
});

test('plain line never contains escapes or newlines', () => {
  for (const s of [makeSnapshot(), makeSnapshot({ state: 'WARMUP', grade: { grade: null, raw: null, tags: [], underLoad: false } })]) {
    const line = renderPlainLine(s);
    expect(line.includes('\x1b')).toBe(false);
    expect(line.includes('\n')).toBe(false);
  }
});

test('DOWN shows cause, no grade and the ticking down clock', () => {
  const snap = makeSnapshot({
    state: 'DOWN', cause: 'uplink', downFor: 42, grade: { grade: null, raw: null, tags: [], underLoad: false },
    latencyMs: null, latencyP95: null, jitter: null, loss60: 100, loss10: 100,
    http: null, dnsDirect: null, dnsSys: null, inKBs: null, outKBs: null,
    verdicts: VERDICTS.map((v) => ({ ...v, level: 'NO', reason: 'offline' })),
  });
  expect(renderPlainLine(snap)).toBe(
    '14:32:07 DOWN/uplink - down 0:42 | gw 7ms 0% | inet p50 - p95 - jit - loss 100% | dns -/- | http - | wifi -72 | in - out - | CHAT NO BROWSE NO VIDEO NO DOWNLOAD NO',
  );
});

test('WARMUP, DEGRADED, under-load marker and ? verdicts', () => {
  const warm = makeSnapshot({
    state: 'WARMUP', grade: { grade: null, raw: null, tags: [], underLoad: false },
    verdicts: VERDICTS.map((v) => ({ ...v, level: '?', reason: '' })),
  });
  expect(renderPlainLine(warm).startsWith('14:32:07 WARMUP - warmup | ')).toBe(true);
  expect(renderPlainLine(warm).endsWith('| CHAT ? BROWSE ? VIDEO ? DOWNLOAD ?')).toBe(true);
  const deg = makeSnapshot({ state: 'DEGRADED', cause: 'dns', steadyFor: 62, grade: { grade: 'C', raw: 'C', tags: [], underLoad: true } });
  expect(renderPlainLine(deg).startsWith('14:32:07 DEGRADED/dns C~ steady 1m02s | ')).toBe(true);
});

test('icmp-blocked, no-icmp router, failed DNS, stale/off wifi', () => {
  const snap = makeSnapshot({
    icmpBlocked: true, gwNoIcmp: true, latencySource: 'http', latencyMs: 120, latencyP95: null, lossSource: 'router',
    dnsDirect: { ok: false, ms: null, server: null, status: 'SERVFAIL', err: 'DNS_ERROR', at: NOW, ageS: 0 },
    dnsSys: { ok: true, ms: 380, server: '100.100.100.100', status: 'NOERROR', err: null, at: NOW, ageS: 0 },
    wifiStatus: 'stale',
  });
  const line = renderPlainLine(snap);
  expect(line).toContain('| gw no-icmp |');
  expect(line).toContain('| inet http 120 jit 71 loss 2% (router) |');
  expect(line).toContain('| dns x/380 |');
  expect(line).toContain('| wifi -72? |');
  expect(renderPlainLine(makeSnapshot({ wifiStatus: 'off' }))).toContain('| wifi off |');
  expect(renderPlainLine(makeSnapshot({ wifiStatus: 'reading', wifi: null }))).toContain('| wifi ? |');
  expect(renderPlainLine(makeSnapshot({ http: { ...snap.http!, kind: 'portal', code: 302, ms: 1800 } }))).toContain('| http portal 1.8s |');
});

test('EVENT lines for transitions and closed outages', () => {
  const t: Transition = { from: 'UP', to: 'DOWN', cause: 'uplink', at: NOW, wall: WALL, startedAt: WALL - 4000, startedAtMono: NOW - 4000 };
  expect(renderPlainEvent(t)).toBe('14:32:07 EVENT UP -> DOWN/uplink since 14:32:03');
  const up: Transition = { ...t, from: 'DOWN', to: 'UP', cause: null };
  expect(renderPlainEvent(up)).toBe('14:32:07 EVENT DOWN -> UP since 14:32:03');
  const o: Outage = { n: 3, state: 'DOWN', cause: 'uplink', startedAt: WALL - 22000, endedAt: WALL, durationS: 22, sleep: false };
  expect(renderPlainEvent(o)).toBe('14:32:07 EVENT outage #3 DOWN/uplink 14:31:45 -> 14:32:07 lasted 22s');
  const sl: Outage = { ...o, n: 4, state: 'PORTAL', cause: 'portal', sleep: true, durationS: 64 };
  expect(renderPlainEvent(sl)).toBe('14:32:07 EVENT outage #4 PORTAL/portal 14:31:45 -> 14:32:07 lasted 1m04s (sleep)');
  const open: Outage = { ...o, endedAt: null, durationS: 5 };
  expect(renderPlainEvent(open)).toBe('14:31:45 EVENT outage #3 DOWN/uplink 14:31:45 -> open lasted 5s');
  for (const e of [t, o, sl]) expect(renderPlainEvent(e).includes('\x1b')).toBe(false);
});
