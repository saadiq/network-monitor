import { test, expect } from 'bun:test';
import { bannerLines, bannerSegments, expectation, bindingReason, primaryReason } from '../src/model/banner-text';
import { GLYPHS } from '../src/ui/ansi';
import { makeSnapshot, makeGrade, makeDrops, makeTrend, makeVerdicts, allOkVerdicts, makeWifi, NO_DROPS, FLAT_TREND } from './helpers/snapshot';

// ---- line 1 -------------------------------------------------------------------

test('line 1 mockup: UP · OK (B) · steady · trend · drops', () => {
  const snap = makeSnapshot();
  expect(bannerSegments(snap)).toEqual(['● UP · OK (B)', 'steady 4m12s', 'getting worse ▲', '3 drops in 15m']);
  expect(bannerLines(snap)[0]).toBe('● UP · OK (B)     steady 4m12s     getting worse ▲     3 drops in 15m');
});

test('line 1 DOWN example: cause, ticking clock, no grade', () => {
  const snap = makeSnapshot({ state: 'DOWN', cause: 'uplink', grade: makeGrade({ grade: null, raw: null }), downFor: 42, trend: FLAT_TREND });
  expect(bannerSegments(snap)).toEqual(['● DOWN · uplink', 'DOWN 0:42', '3 drops in 15m']);
});

test('line 1 PORTAL / NO LINK clocks; portal cause not repeated', () => {
  const portal = makeSnapshot({ state: 'PORTAL', cause: 'portal', grade: makeGrade({ grade: null }), downFor: 65, trend: FLAT_TREND, drops: NO_DROPS });
  expect(bannerSegments(portal)).toEqual(['● PORTAL', 'PORTAL 1:05']);
  const nl = makeSnapshot({ state: 'NO_LINK', cause: 'not-joined', grade: makeGrade({ grade: null }), downFor: 12, trend: FLAT_TREND, drops: NO_DROPS });
  expect(bannerSegments(nl)).toEqual(['● NO LINK · not-joined', 'NO LINK 0:12']);
});

test('line 1 offline without downFor falls back to time since transition', () => {
  const snap = makeSnapshot({ state: 'DOWN', cause: 'router', grade: makeGrade({ grade: null }), downFor: null, since: makeSnapshot().now - 7000, trend: FLAT_TREND, drops: NO_DROPS });
  expect(bannerSegments(snap)[1]).toBe('DOWN 0:07');
});

test('line 1 optional segments: improving, FLAKY, sat, under load, singular drop', () => {
  const snap = makeSnapshot({
    grade: makeGrade({ tags: ['FLAKY'], underLoad: true }), sat: true, rttOffset: 600,
    trend: makeTrend({ overall: 'better', phrase: 'improving' }), drops: makeDrops({ drops15: 1 }),
  });
  expect(bannerSegments(snap)).toEqual(['● UP · OK (B)', 'steady 4m12s', 'improving ▼', '1 drop in 15m', 'FLAKY', 'sat +600ms', '~ under load']);
});

test('line 1 DEGRADED: quality shows only the grade; dns shows cause and grade', () => {
  const q = makeSnapshot({ state: 'DEGRADED', cause: 'quality', grade: makeGrade({ grade: 'C' }), trend: FLAT_TREND, drops: NO_DROPS });
  expect(bannerSegments(q)[0]).toBe('● DEGRADED · POOR (C)');
  const d = makeSnapshot({ state: 'DEGRADED', cause: 'dns', grade: makeGrade({ grade: 'A' }), trend: FLAT_TREND, drops: NO_DROPS });
  expect(bannerSegments(d)[0]).toBe('● DEGRADED · dns · GOOD (A)');
});

test('line 1 WARMUP is just the state; UP without a grade yet', () => {
  const w = makeSnapshot({ state: 'WARMUP', grade: makeGrade({ grade: null }), trend: FLAT_TREND, drops: NO_DROPS, steadyFor: 3 });
  expect(bannerSegments(w)).toEqual(['● WARMUP']);
  const u = makeSnapshot({ grade: makeGrade({ grade: null }), trend: FLAT_TREND, drops: NO_DROPS, steadyFor: 9 });
  expect(bannerSegments(u)).toEqual(['● UP', 'steady 9s']);
});

test('ascii glyphs', () => {
  const snap = makeSnapshot();
  expect(bannerSegments(snap, GLYPHS.ascii)).toEqual(['* UP | OK (B)', 'steady 4m12s', 'getting worse ^', '3 drops in 15m']);
  const w = makeSnapshot({ state: 'WARMUP', grade: makeGrade({ grade: null }) });
  expect(bannerLines(w, GLYPHS.ascii)[1]).toBe('Measuring... first verdict in a few seconds.');
});

// ---- line 2 -------------------------------------------------------------------

const line2 = (s: Parameters<typeof makeSnapshot>[0]) => bannerLines(makeSnapshot(s))[1];

test('WARMUP', () => {
  expect(line2({ state: 'WARMUP', grade: makeGrade({ grade: null }) })).toBe('Measuring… first verdict in a few seconds.');
});

test('UP/A', () => {
  expect(line2({ grade: makeGrade({ grade: 'A' }), verdicts: allOkVerdicts() }))
    .toBe('Good connection. Calls, browsing and downloads should all work.');
});

test('UP/A does not claim everything works while an activity is still shaky', () => {
  const verdicts = makeVerdicts({
    'VIDEO CALL': { level: 'SHAKY', reason: 'drop 3m ago · audio ok' },
    DOWNLOAD: { level: 'SHAKY', reason: 'drop 3m ago' },
  });
  expect(line2({ grade: makeGrade({ grade: 'A' }), verdicts }))
    .toBe('Good connection, but recent instability: Video call shaky (drop 3m ago). Big downloads: shaky (drop 3m ago).');
});

test('UP/B mockup sentence with video + download notes (audio suffix stripped)', () => {
  expect(line2({})).toBe('Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no (3 drops/15m).');
});

test('UP/B with everything OK; UP without grade uses the same template', () => {
  expect(line2({ verdicts: allOkVerdicts() })).toBe('Fine for chat & browsing.');
  expect(line2({ grade: makeGrade({ grade: null }), verdicts: allOkVerdicts() })).toBe('Fine for chat & browsing.');
  const noReason = makeVerdicts({ 'VIDEO CALL': { level: 'NO', reason: '' }, DOWNLOAD: { level: 'OK', reason: '' } });
  expect(line2({ verdicts: noReason })).toBe('Fine for chat & browsing. Video call no.');
});

test('grade C / D use the binding reason', () => {
  expect(line2({ state: 'DEGRADED', cause: 'quality', grade: makeGrade({ grade: 'C' }), jitter: 140 }))
    .toBe('Struggling (jitter 140ms). Chat works; pages will crawl. Skip calls.');
  expect(line2({ state: 'DEGRADED', cause: 'quality', grade: makeGrade({ grade: 'D' }), loss60: 20, jitter: 200 }))
    .toBe('Barely there (loss 20%). Only messaging is realistic right now.');
});

test('bindingReason: order loss > rtt > p95 > jitter, sat offset applied, absolute numbers shown', () => {
  const c = { state: 'DEGRADED' as const, cause: 'quality' as const, grade: makeGrade({ grade: 'C' }) };
  expect(bindingReason(makeSnapshot({ ...c, loss60: 12, latencyMs: 900 }))).toBe('loss 12%');
  expect(bindingReason(makeSnapshot({ ...c, latencyMs: 800, jitter: 10 }))).toBe('slow 0.8s');
  expect(bindingReason(makeSnapshot({ ...c, latencyMs: 100, latencyP95: 1200, jitter: 10 }))).toBe('p95 1.2s');
  expect(bindingReason(makeSnapshot({ ...c, latencyMs: 700, latencyP95: 900, sat: true, rttOffset: 600, jitter: 10 }))).not.toBe('slow 0.7s');
  expect(bindingReason(makeSnapshot({ ...c, latencyMs: 1000, sat: true, rttOffset: 600, jitter: 10 }))).toBe('slow 1.0s');
  expect(bindingReason(makeSnapshot({ ...c, jitter: 10, loss300: 14 }))).toBe('loss 14% over 5m');
  expect(bindingReason(makeSnapshot({ ...c, jitter: 10, verdicts: makeVerdicts({ 'VIDEO CALL': { reason: 'drop 4m ago · audio ok' } }) }))).toBe('drop 4m ago');
  expect(bindingReason(makeSnapshot({ ...c, jitter: 10, verdicts: allOkVerdicts() }))).toBe('poor link');
});

test('DEGRADED/dns with and without the Tailscale suffix', () => {
  const both = { state: 'DEGRADED' as const, cause: 'dns' as const, dnsSysOk: false, dnsDirectOk: false, dnsOk: false };
  expect(line2(both)).toBe("Pings work but names don't resolve — browsing is broken.");
  expect(line2({ ...both, dnsDirectOk: true, dnsOk: true }))
    .toBe("Pings work but names don't resolve — browsing is broken. Direct DNS works: likely Tailscale, not the network.");
  expect(line2({ ...both, dnsDirectOk: true, dnsOk: true, dnsServer: '192.168.0.1' }))
    .toBe("Pings work but names don't resolve — browsing is broken. Direct DNS works: likely the resolver, not the network.");
});

test('DEGRADED/web shows the streak', () => {
  expect(line2({ state: 'DEGRADED', cause: 'web', webFailStreak: 3 }))
    .toBe('Pings work but web requests fail (3 in a row) — a portal or proxy may be interfering.');
  expect(line2({ state: 'DEGRADED', cause: 'web', webFailStreak: 0 })).toContain('(3 in a row)');
});

test('DOWN sentences with expectation', () => {
  const down = { state: 'DOWN' as const, grade: makeGrade({ grade: null }), downFor: 42 };
  expect(line2({ ...down, cause: 'uplink' }))
    .toBe("Upstream link dropped — router fine, it's not you. Drops here usually last ~22s (longest 1m04s).");
  expect(line2({ ...down, cause: 'router' }))
    .toBe("Can't reach the router (signal -72 dBm). Move the laptop or re-join Wi-Fi. Drops here usually last ~22s (longest 1m04s).");
  expect(line2({ ...down, cause: 'wifi', wifi: makeWifi({ rssi: -88 }) }))
    .toBe('Wi-Fi link weak or lost (signal -88 dBm). Move the laptop or re-join the network. Drops here usually last ~22s (longest 1m04s).');
  expect(line2({ ...down, cause: 'router', wifi: null }))
    .toBe("Can't reach the router. Move the laptop or re-join Wi-Fi. Drops here usually last ~22s (longest 1m04s).");
});

test('PORTAL and NO_LINK sentences', () => {
  expect(line2({ state: 'PORTAL', cause: 'portal', downFor: 65, drops: NO_DROPS }))
    .toBe('Captive portal wants a login. Press o to open the login page. First drop this session.');
  expect(line2({ state: 'NO_LINK', cause: 'not-joined' })).toBe('Not joined to any Wi-Fi network. Join a Wi-Fi network from the menu bar.');
  expect(line2({ state: 'NO_LINK', cause: 'no-dhcp' })).toBe('Joined Wi-Fi but got no address from the router (DHCP). Usually clears in ~30s; otherwise re-join.');
  expect(line2({ state: 'NO_LINK', cause: 'unknown' })).toBe('No network route. Check Wi-Fi in the menu bar.');
});

test('expectation phrases', () => {
  expect(expectation(makeSnapshot({ drops: NO_DROPS }))).toBe('First drop this session.');
  expect(expectation(makeSnapshot({ downFor: 30 }))).toBe('Drops here usually last ~22s (longest 1m04s).');
  expect(expectation(makeSnapshot({ downFor: 65 }))).toBe('Longer than any drop so far.');
  expect(expectation(makeSnapshot({ downFor: 64 }))).toBe('Drops here usually last ~22s (longest 1m04s).');
  const one = makeDrops({ dropsSession: 1, drops15: 1, dropMedianS: 22, dropLongestS: 22 });
  expect(expectation(makeSnapshot({ drops: one, downFor: 10 }))).toBe('Last drop here lasted 22s.');
  expect(expectation(makeSnapshot({ drops: one, downFor: 23 }))).toBe('Longer than any drop so far.');
});

test('primaryReason strips the audio note in both glyph modes', () => {
  expect(primaryReason('jitter 71ms · audio ok')).toBe('jitter 71ms');
  expect(primaryReason('jitter 71ms | audio ok')).toBe('jitter 71ms');
  expect(primaryReason('loss 12%')).toBe('loss 12%');
});
