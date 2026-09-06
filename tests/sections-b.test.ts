import { test, expect } from 'bun:test';
import { metrics } from '../src/ui/sections/metrics';
import { timeline } from '../src/ui/sections/timeline';
import { drops } from '../src/ui/sections/drops';
import { tip, footer } from '../src/ui/sections/footer';
import { planLayout } from '../src/ui/layout';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { makeSnapshot, makeOutage, makeTrend, makeWifi, makeSpeed, NO_DROPS, wallAt, NOW, makeHttp } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const FULL = planLayout({ cols: 100, rows: 30 });
const C80 = planLayout({ cols: 80, rows: 24 });
const C72 = planLayout({ cols: 72, rows: 18 });

const ui = (o: Partial<UiState> = {}): UiState =>
  ({ bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null, lastSpeed: null, speedRunning: false, logStatus: null, ...o });

const cells = (row: string): string[] => [2, 26, 50, 74].map((i) => strip(row).slice(i, i + 24));

function expectFits(lines: string[], w: number, n: number): void {
  expect(lines.length).toBe(n);
  for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
}

// eslint-disable-next-line no-control-regex
const ASCII_RE = /^[\x00-\x7f]*$/;

// ---- metrics ------------------------------------------------------------------

test('metrics full: six rows, four 24-cell columns at 3/27/51/75 matching the §8.1 mockup', () => {
  const rows = metrics(makeSnapshot(), FULL, G, true);
  expectFits(rows, 100, 6);
  expect(cells(rows[0] ?? '')).toEqual(['LATENCY (60s) p50   p95 ', 'LOSS          10s   60s ', 'WI-FI (28s ago)         ', 'TRAFFIC (passive)       ']);
  const r1 = cells(rows[1] ?? '');
  expect(r1[0]).toBe('router          7    11 ');
  expect(r1[1]).toBe('router         0%    0% ');
  expect(r1[2]).toBe('signal -72 dBm   snr 23 ');
  expect(r1[3]).toBe('in    42 KB/s ▃▄▇▄▂▂▃▅▆█');
  const r2 = cells(rows[2] ?? '');
  expect(r2[0]).toBe('internet       48    86 ');
  expect(r2[1]).toBe('internet       0%    2% ');
  expect(r2[2]).toBe('noise  -95 dBm   fair   ');
  expect(r2[3]?.startsWith('out    6 KB/s ')).toBe(true);
  const r3 = cells(rows[3] ?? '');
  expect(r3[0]).toBe('jitter         71 ms ▲  ');
  expect(r3[1]).toBe('5m 4%   blips 1 (60s)   ');
  expect(r3[2]).toBe('tx 216 Mbps  MCS 4      ');
  expect(r3[3]).toBe('session 38.2 MB↓ 4.1 MB↑');
  const r4 = cells(rows[4] ?? '');
  expect(r4[0]).toBe('http     0.31 s (200)   ');
  expect(r4[1]).toBe('late 0  unmeasured 0    ');
  expect(r4[2]).toBe('802.11ax ch157 5GHz/80  ');
  expect(r4[3]).toBe('test 12m ago: ↓2.8 MB/s ');
  const r5 = strip(rows[5] ?? '');
  expect(r5.startsWith('  RTT 60s ')).toBe(true);
  expect(r5.slice(10, 70).length).toBe(60);
  expect(r5.endsWith('  40–58ms  x = lost')).toBe(true);
  expect(rows[3]?.includes('\x1b[33m▲')).toBe(true); // latency trend arrow colored
});

test('metrics full: loss trend arrow hugs the 60s value; lost samples are red x; nulls are em dashes', () => {
  const snap = makeSnapshot({
    trend: makeTrend({ loss: 'worse', latency: 'flat' }),
    rttHistory: [40, null, 42, 300, null],
    jitter: null, latencyMs: null, inet: { ...makeSnapshot().inet, p50: null, p95: null },
    inKBs: null, wifi: makeWifi({ rssi: null, snr: null, label: null, txRate: null, mcs: null, channel: null, phy: null }),
    http: null, speed: null,
  });
  const rows = metrics(snap, FULL, G, true);
  expect(cells(rows[2] ?? '')[1]).toBe('internet       0%   2%▲ ');
  expect(cells(rows[2] ?? '')[0]).toBe('internet        —     — ');
  expect(cells(rows[3] ?? '')[0]).toBe('jitter          —       ');
  expect(cells(rows[1] ?? '')[2]).toBe('signal —         snr —  ');
  expect(cells(rows[1] ?? '')[3]?.startsWith('in          — ')).toBe(true);
  expect(cells(rows[4] ?? '')[0]).toBe('http     —              ');
  expect(cells(rows[4] ?? '')[2]).toBe('— —                     ');
  expect(cells(rows[4] ?? '')[3]).toBe('test — press t          ');
  expect(rows[5]?.includes('\x1b[31mx\x1b[39m')).toBe(true);
  expect(strip(rows[5] ?? '').endsWith('  40–300ms  x = lost')).toBe(true);
  const plain = metrics(snap, FULL, G, false);
  expect(plain.some((l) => l.includes('\x1b['))).toBe(false);
});

test('metrics full: icmp-blocked labels, wifi states, missing binaries, failed speed test', () => {
  const blocked = metrics(makeSnapshot({ icmpBlocked: true, lossSource: 'router', latencySource: 'http' }), FULL, G, false);
  expect(cells(blocked[0] ?? '')[1]).toBe('LOSS (router) 10s   60s ');
  expect(cells(blocked[2] ?? '')[0]).toBe('internet      120 http  ');
  expect(cells(blocked[2] ?? '')[1]).toBe('internet – no icmp      ');

  const reading = metrics(makeSnapshot({ wifi: null, wifiStatus: 'reading' }), FULL, G, false);
  expect(cells(reading[0] ?? '')[2]).toBe('WI-FI (reading…)        ');
  expect(cells(reading[1] ?? '')[2]).toBe('signal —         snr —  ');
  const stale = metrics(makeSnapshot({ wifi: makeWifi({ ageS: 200 }), wifiStatus: 'stale' }), FULL, G, false);
  expect(cells(stale[0] ?? '')[2]).toBe('WI-FI (3m ago)          ');
  expect(cells(stale[1] ?? '')[2]).toBe('signal —         snr —  ');
  const off = metrics(makeSnapshot({ wifi: null, wifiStatus: 'off' }), FULL, G, false);
  expect(cells(off[0] ?? '')[2]).toBe('WI-FI (off)             ');
  expect(cells(off[1] ?? '')[2]).toBe('not the egress          ');
  const notAssoc = metrics(makeSnapshot({ wifi: makeWifi({ assoc: 'no' }) }), FULL, G, false);
  expect(cells(notAssoc[1] ?? '')[2]).toBe('not associated          ');

  const bins = ['/usr/bin/curl', '/usr/sbin/system_profiler', '/usr/sbin/netstat', '/sbin/ping'];
  const missing = metrics(makeSnapshot({ missingBins: bins }), FULL, G, false);
  expect(cells(missing[1] ?? '')[0]).toBe('ping: missing           ');
  expect(cells(missing[4] ?? '')[0]).toBe('http     curl: missing  ');
  expect(cells(missing[1] ?? '')[2]).toBe('profiler: missing       ');
  expect(cells(missing[1] ?? '')[3]).toBe('netstat: missing        ');

  const failed = metrics(makeSnapshot({ speed: makeSpeed({ ok: false, downMbps: null, why: 'timeout', ageS: 40 }) }), FULL, G, false);
  expect(cells(failed[4] ?? '')[3]).toBe('test 40s ago: failed    ');
  const loaded = metrics(makeSnapshot({ loadedNow: true, http: makeHttp({ kind: 'fail', code: 0, ms: null }) }), FULL, G, false);
  expect(cells(loaded[0] ?? '')[3]).toBe('TRAFFIC (loaded ~)      ');
  expect(cells(loaded[4] ?? '')[0]).toBe('http     fail           ');
});

test('metrics compact (80 and 72 cols): two cells, LOSS at col 40, wifi+traffic line', () => {
  const rows = metrics(makeSnapshot(), C80, G, true);
  expectFits(rows, 80, 6);
  const s = rows.map(strip);
  expect(s[0]?.slice(0, 43)).toBe('  LATENCY (60s) p50   p95              LOSS');
  expect(s[1]?.slice(2, 26)).toBe('router          7    11 ');
  expect(s[1]?.slice(39)).toBe('router         0%    0%');
  expect(s[2]?.slice(39)).toBe('internet       0%    2%');
  expect(s[3]?.slice(2, 24)).toBe('jitter         71 ms ▲');
  expect(s[3]?.slice(39)).toBe('5m 4%   blips 1   late 0');
  expect(s[4]?.slice(39)).toBe('unmeasured 0   errs 0');
  expect(s[5]).toBe('  wifi -72 dBm snr 23 tx 216 · in 42 KB/s out 6 KB/s · 38.2 MB↓ 4.1 MB↑');
  const arrow = metrics(makeSnapshot({ trend: makeTrend({ loss: 'better' }) }), C80, G, false).map(strip);
  expect(arrow[2]?.slice(39)).toBe('internet       0%  2% ▼');
  const narrow = metrics(makeSnapshot(), C72, G, true);
  expectFits(narrow, 72, 6);
  expect(strip(narrow[0] ?? '').indexOf('LOSS')).toBe(37);
  expect(strip(narrow[5] ?? '')).toBe('  wifi -72 dBm snr 23 tx 216 · in 42 KB/s out 6 KB/s · 38.2 MB↓ 4.1 MB↑');
  const wide = metrics(makeSnapshot(), planLayout({ cols: 120, rows: 24 }), G, false).map(strip);
  expect(wide[5]).toBe('  wifi -72 dBm snr 23 tx 216 · in 42 KB/s out 6 KB/s · 38.2 MB↓ 4.1 MB↑ · test ↓2.8 MB/s 12m ago');
});

test('metrics ascii: pure ASCII in both layouts', () => {
  const snap = makeSnapshot({ rttHistory: [40, null, 50], trend: makeTrend({ loss: 'worse' }) });
  for (const rows of [metrics(snap, FULL, A, true), metrics(snap, C80, A, true)]) {
    for (const r of rows) expect(ASCII_RE.test(r)).toBe(true);
  }
  expect(strip(metrics(snap, FULL, A, false)[5] ?? '').endsWith('  40-50ms  x = lost')).toBe(true);
});

// ---- timeline -----------------------------------------------------------------

test('timeline full: bar of 90 cells and a marker row with -15m / ▲HH:MM cause / now', () => {
  const rows = timeline(makeSnapshot(), FULL, G, true);
  expectFits(rows, 100, 2);
  expect(strip(rows[0] ?? '')).toBe(' LAST 15m ' + '█'.repeat(90));
  expect(rows[0]?.includes('\x1b[32m')).toBe(true);
  expect(strip(rows[1] ?? '').slice(0, 10)).toBe(' '.repeat(10));
  const r = strip(rows[1] ?? '').slice(10);
  expect(r.length).toBe(90);
  expect(r.slice(0, 4)).toBe('-15m');
  expect(r.slice(11, 22)).toBe('▲14:19 wifi');
  expect(r.slice(24, 37)).toBe('▲14:21 portal');
  expect(r.slice(64, 77)).toBe('▲14:27 uplink');
  expect(r.slice(87)).toBe('now');
  expect(rows[1]?.includes('\x1b[35m▲14:21 portal')).toBe(true); // portal marker magenta
});

test('timeline: right-most marker wins a collision; markers near the edge shrink; open and sleep outages', () => {
  const extra = [
    makeOutage({ n: 5, cause: 'uplink', startedAt: wallAt('14:30:30'), durationS: 5 }),
    makeOutage({ n: 4, cause: 'router', startedAt: wallAt('14:28:05'), durationS: 5 }),
    makeOutage({ n: 6, cause: 'wifi', startedAt: wallAt('14:25:00'), durationS: 5, sleep: true }),
  ];
  const r = strip(timeline(makeSnapshot({ outages: [...extra, ...makeSnapshot().outages] }), FULL, G, false)[1] ?? '').slice(10);
  expect(r[64]).toBe('▲');
  expect(r.slice(65, 78)).toBe('▲14:28 router');
  expect(r.slice(80, 86)).toBe('▲14:30');
  expect(r.slice(87)).toBe('now');
  expect(r.includes('14:25')).toBe(false); // sleep-closed outages carry no marker
  const open = makeOutage({ n: 4, cause: 'portal', state: 'PORTAL', startedAt: wallAt('14:31:30'), endedAt: null, durationS: 37 });
  const o = strip(timeline(makeSnapshot({ openOutage: open, state: 'PORTAL', downFor: 37 }), FULL, G, false)[1] ?? '').slice(10);
  expect(o.slice(87)).toBe('now');
  expect(o[86]).toBe(' '); // 37s old: no room left of `now`, so the marker waits (the bar shows the drop)
  const early = makeOutage({ n: 0, cause: 'uplink', startedAt: wallAt('14:17:10'), durationS: 5 });
  const e = strip(timeline(makeSnapshot({ outages: [early] }), FULL, G, false)[1] ?? '').slice(10);
  expect(e.slice(0, 13)).toBe('▲14:17 uplink'); // overwrites the -15m label
});

test('timeline compact and ascii: 60 cells at 80/72 cols, pure ASCII glyphs', () => {
  const snap = makeSnapshot({ timeline: (n) => Array.from({ length: n }, (_, i) => (i < 10 ? 'DOWN' : i < 20 ? 'PORTAL' : i < 25 ? 'GAP' : 'UP')) });
  const rows = timeline(snap, C80, G, true);
  expectFits(rows, 80, 2);
  expect(strip(rows[0] ?? '')).toBe(' LAST 15m ' + '░'.repeat(10) + '▒'.repeat(10) + '·'.repeat(5) + '█'.repeat(35));
  const r = strip(rows[1] ?? '').slice(10);
  expect([r.length, r.slice(0, 4)]).toEqual([60, '-15m']);
  expect(r.slice(57)).toBe('now');
  expect(r.slice(7, 16)).toBe('▲14:19   '); // cell 7; shrunk to its stamp by the 14:21 marker at cell 16
  expect(r.slice(16, 29)).toBe('▲14:21 portal');
  const narrow = timeline(snap, C72, A, true);
  expectFits(narrow, 72, 2);
  for (const l of narrow) expect(ASCII_RE.test(l)).toBe(true);
  expect(strip(narrow[0] ?? '')).toBe(' LAST 15m ' + '.'.repeat(10) + ':'.repeat(10) + '.'.repeat(5) + '#'.repeat(35));
  expect(strip(narrow[1] ?? '').slice(10).slice(16, 29)).toBe('^14:21 portal');
  const short = timeline(makeSnapshot({ timeline: (n) => Array.from({ length: n - 5 }, () => 'UP' as const) }), C80, G, false);
  expect(strip(short[0] ?? '')).toBe(' LAST 15m ' + '·'.repeat(5) + '█'.repeat(55));
});

// ---- drops --------------------------------------------------------------------

test('drops full: header + three newest, stats column at col 54 (§8.1 mockup)', () => {
  const rows = drops(makeSnapshot(), FULL, G, true);
  const s = rows.map((r) => strip(r).trimEnd());
  expectFits(rows, 100, 4);
  expect(s[0]).toBe('  DROPS  #  started   lasted  cause                  3 drops/15m · median 22s · longest 1m04s');
  expect(s[1]).toBe('         3  14:27:55  22s     uplink (router fine)   last ended 4m12s ago · uptime 15m 91%');
  expect(s[2]).toBe('         2  14:21:10  1m04s   portal login needed    usually ~22s; 2 of 3 under 30s');
  expect(s[3]).toBe('         1  14:19:02  9s      wi-fi link lost        gap between drops ~4m');
});

test('drops full: no drops, an open outage, sleep-closed rows skipped, other causes', () => {
  const none = drops(makeSnapshot({ outages: [], drops: NO_DROPS }), FULL, G, false).map((r) => strip(r).trimEnd());
  expect(none[0]).toBe('  DROPS  #  started   lasted  cause                  no drops yet · uptime 15m 100% · 1h 100%');
  expect(none[1]).toBe('         —  no drops this session');
  expect(none[2]).toBe('');
  const open = makeOutage({ n: 4, cause: 'router', startedAt: wallAt('14:31:25'), endedAt: null, durationS: 42 });
  const withOpen = drops(makeSnapshot({ openOutage: open, downFor: 42, state: 'DOWN' }), FULL, G, false).map((r) => strip(r).trimEnd());
  expect(withOpen[1]).toBe('         4  14:31:25  42s…    router unreachable     last ended 4m12s ago · uptime 15m 91%');
  expect(withOpen[2]?.startsWith('         3  14:27:55  22s     uplink (router fine)')).toBe(true);
  const sleep = makeOutage({ n: 4, cause: 'uplink', startedAt: wallAt('14:29:00'), durationS: 30, sleep: true });
  const nl = makeOutage({ n: 5, state: 'NO_LINK', cause: 'no-dhcp', startedAt: wallAt('14:30:00'), durationS: 31 });
  const other = drops(makeSnapshot({ outages: [nl, sleep, ...makeSnapshot().outages] }), FULL, G, false).map((r) => strip(r).trimEnd());
  expect(other[1]?.startsWith('         5  14:30:00  31s     no address (DHCP)')).toBe(true);
  expect(other[2]?.startsWith('         3  14:27:55')).toBe(true);
  expect(other.some((l) => l.includes('14:29:00'))).toBe(false);
  const uptimeNull = drops(makeSnapshot({ drops: { ...NO_DROPS, uptime15: null, uptime60: null } }), FULL, G, false);
  expect(strip(uptimeNull[0] ?? '').includes('uptime 15m —')).toBe(true);
});

test('drops compact: no header row, short causes, stats at col 45 (§8.2 mockup); word-safe cut at 72', () => {
  const rows = drops(makeSnapshot(), C80, G, false);
  const s = rows.map((r) => strip(r).trimEnd());
  expectFits(rows, 80, 3);
  expect(s[0]).toBe('  DROPS  3  14:27:55  22s     uplink        3 drops/15m · median 22s · max 1m04s');
  expect(s[1]).toBe('         2  14:21:10  1m04s   portal        last ended 4m12s ago · uptime 91%');
  expect(s[2]).toBe('         1  14:19:02  9s      wi-fi link    usually ~22s; 2 of 3 under 30s');
  const n = drops(makeSnapshot(), C72, G, false).map((r) => strip(r).trimEnd());
  expectFits(n, 72, 3);
  expect(n[0]).toBe('  DROPS  3  14:27:55  22s     uplink   3 drops/15m · median 22s');
  expect(n[2]).toBe('         1  14:19:02  9s      wi-fi    usually ~22s; 2 of 3 under 30s');
  const four = drops(makeSnapshot(), planLayout({ cols: 80, rows: 30 }), G, false).map((r) => strip(r).trimEnd());
  expect(four.length).toBe(4);
  expect(four[3]).toBe(' '.repeat(44) + 'gap between drops ~4m');
  const one = drops(makeSnapshot({ drops: { ...NO_DROPS, drops15: 1, dropsSession: 1, dropMedianS: 22, dropLongestS: 22, dropUnder30: 1, sinceLastDrop: 30 } }), C80, G, false);
  expect(strip(one[0] ?? '').includes('1 drop/15m')).toBe(true);
  expect(drops(makeSnapshot(), { compact: true, cols: 80, dropsRows: 0 }, G, false)).toEqual([]);
  for (const l of drops(makeSnapshot(), C80, A, true)) expect(ASCII_RE.test(l)).toBe(true);
});

test('tip: one row, blank when null, truncated to width', () => {
  expect(tip(makeSnapshot({ tip: null }), 100)).toEqual(['']);
  expect(tip(makeSnapshot({ tip: 'weak signal -84 dBm — move the laptop' }), 100)).toEqual(['  TIP  weak signal -84 dBm — move the laptop']);
  expect(visibleWidth(tip(makeSnapshot({ tip: 'x'.repeat(200) }), 80)[0] ?? '')).toBe(80);
});

test('footer: keys left, probe rate right-aligned to width; live states', () => {
  const f = footer(makeSnapshot(), ui(), 100);
  expect([f.length, visibleWidth(f[0] ?? '')]).toEqual([1, 100]);
  expect(f[0]?.startsWith('  q quit   t speed test (250 KB)   b bell:on   o open portal')).toBe(true);
  expect(f[0]?.endsWith('probes ~1.2 MB/h')).toBe(true);
  const c = footer(makeSnapshot(), ui({ bellOn: false }), 80);
  expect(visibleWidth(c[0] ?? '')).toBe(80); expect(c[0]?.startsWith('  q quit  t speed test (250 KB)  b bell:off  o open portal')).toBe(true);
  expect(c[0]?.endsWith('probes ~1.2 MB/h')).toBe(true);
  const running = footer(makeSnapshot(), ui({ speedRunning: true }), 100)[0] ?? '';
  expect(running.includes('t speed test (running)')).toBe(true);
  const log = footer(makeSnapshot(), ui({ logStatus: 'off (EACCES)' }), 100)[0] ?? '';
  expect(log.endsWith('log: off (EACCES)  probes ~1.2 MB/h')).toBe(true);
  const msg = footer(makeSnapshot(), ui({ footerMsg: 'not while down', footerMsgUntil: NOW + 3000 }), 100)[0] ?? '';
  expect([msg.includes('o open portal   not while down'), visibleWidth(msg)]).toEqual([true, 100]);
  const expired = footer(makeSnapshot(), ui({ footerMsg: 'not while down', footerMsgUntil: NOW - 1 }), 100)[0] ?? '';
  expect(expired.includes('not while down')).toBe(false);
  const n = footer(makeSnapshot(), ui(), 72)[0] ?? '';
  expect(visibleWidth(n)).toBe(72);
  expect(n.startsWith('  q quit  t speed test  b bell:on  o open portal')).toBe(true);
  expect(n.endsWith('probes ~1.2 MB/h')).toBe(true);
  const nl = footer(makeSnapshot(), ui({ logStatus: 'off (EACCES)' }), 72)[0] ?? '';
  expect([visibleWidth(nl), nl.includes('o open portal'), nl.endsWith('log: off (EACCES)')]).toEqual([72, true, true]);
  expect(ASCII_RE.test(footer(makeSnapshot(), ui({ logStatus: 'on', footerMsg: 'hi', footerMsgUntil: null }), 100)[0] ?? '')).toBe(true);
});

test('every section stays within width at 72, 80, 100 and 140 cols', () => {
  const snap = makeSnapshot({ tip: 't'.repeat(150), rttHistory: [5, null, 900] });
  for (const cols of [72, 80, 100, 140]) {
    const plan = planLayout({ cols, rows: cols >= 100 ? 30 : 24 });
    const all = [
      ...metrics(snap, plan, G, true), ...timeline(snap, plan, G, true), ...drops(snap, plan, G, true),
      ...tip(snap, cols), ...footer(snap, ui({ logStatus: 'on', footerMsg: 'm'.repeat(60), footerMsgUntil: null }), cols),
    ];
    for (const l of all) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
  }
});
