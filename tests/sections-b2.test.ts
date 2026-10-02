// UI sections B (continued): the §8.1 cell-gutter rule (K1) and the shedding paths of the
// metrics / footer / timeline sections. Same fixtures as sections-b.test.ts.
import { test, expect } from 'bun:test';
import { metrics } from '../src/ui/sections/metrics';
import { timeline } from '../src/ui/sections/timeline';
import { footer } from '../src/ui/sections/footer';
import { planLayout } from '../src/ui/layout';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { makeSnapshot, makeOutage, makeTrend, makeGwStats, makeStreamStats, wallAt, makeUi } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const FULL = planLayout({ cols: 100, rows: 30 });
const C80 = planLayout({ cols: 80, rows: 24 });
const C72 = planLayout({ cols: 72, rows: 18 });

const ui = (o: Partial<UiState> = {}): UiState => makeUi({ view: 'advanced', ...o });

const cells = (row: string): string[] => [2, 26, 50, 74].map((i) => strip(row).slice(i, i + 24));

// eslint-disable-next-line no-control-regex
const ASCII_RE = /^[\x00-\x7f]*$/;

// ---- metric cell gutters (K1) --------------------------------------------------

/** Last cell of each metric column (§8.1 columns 3/27/51/75): always blank, so columns never touch. */
const GUTTERS = [25, 49, 73];

function expectGutters(rows: string[]): void {
  for (const row of rows.slice(0, 5)) {
    const s = strip(row);
    for (const i of GUTTERS) expect([i, s[i] ?? ' ']).toEqual([i, ' ']);
  }
}

test('metrics full: a gutter always separates the four columns (K1)', () => {
  expectGutters(metrics(makeSnapshot(), FULL, G, true));
  expectGutters(metrics(makeSnapshot(), FULL, A, false));
  const bins = ['/usr/bin/curl', '/usr/sbin/system_profiler', '/usr/sbin/netstat', '/sbin/ping'];
  const missing = metrics(makeSnapshot({ missingBins: bins }), FULL, G, false);
  expectGutters(missing); // 'system_profiler: missing' filled all 24 cells (UI-8)
  expect(cells(missing[1] ?? '')[2]).toBe('profiler: missing       ');
  for (const w of [26, 50, 74]) {
    const row = strip(metrics(makeSnapshot(), FULL, G, false)[1] ?? '');
    expect(`${row[w - 1] ?? ' '}${row[w] ?? ' '}`.trim().length).toBeLessThanOrEqual(1);
  }
});

test('metrics: 100% loss keeps both windows and the trend arrow inside the cell (UI-1)', () => {
  const snap = makeSnapshot({
    gw: makeGwStats({ loss10: 100, loss60: 100 }), inet: makeStreamStats({ loss10: 100, loss60: 100 }),
    loss10: 100, loss60: 100, loss300: 100, trend: makeTrend({ loss: 'worse' }),
  });
  const rows = metrics(snap, FULL, G, false);
  expectGutters(rows);
  expect(cells(rows[1] ?? '')[1]).toBe('router       100%  100% ');
  expect(cells(rows[2] ?? '')[1]).toBe('internet     100% 100%▲ ');
  for (const [plan, at] of [[FULL, 26], [C80, 39], [C72, 37]] as const) {
    for (const rowsOf of [metrics(snap, plan, G, false), metrics(snap, plan, A, false)]) {
      for (const r of rowsOf.slice(1, 3)) {
        const loss = strip(r).slice(at, at + 24).trimEnd(); // the LOSS cell: ≤ 23 cells, so a gutter remains
        expect([at, loss.includes('100%'), visibleWidth(loss) <= 23]).toEqual([at, true, true]);
      }
    }
  }
  // the router row of the icmp-blocked layout carries the same numbers (§6.1)
  const blocked = metrics(makeSnapshot({ ...snap, icmpBlocked: true, lossSource: 'router' }), FULL, G, false);
  expectGutters(blocked);
  expect(cells(blocked[1] ?? '')[1]).toBe('router       100%  100% ');
});

test('metrics: 4- and 5-digit RTTs keep every digit and a label gap (UI-4)', () => {
  const sat = makeSnapshot({
    gw: makeGwStats({ p50: 720, p95: 1180 }), inet: makeStreamStats({ p50: 12000, p95: 12000 }),
    jitter: 1040, trend: makeTrend({ latency: 'worse' }),
  });
  const rows = metrics(sat, FULL, G, false);
  expectGutters(rows);
  expect(cells(rows[0] ?? '')[0]).toBe('LATENCY (60s) p50   p95 ');
  expect(cells(rows[1] ?? '')[0]).toBe('router        720  1180 ');
  expect(cells(rows[2] ?? '')[0]).toBe('internet    12000 12000 ');
  expect(cells(rows[3] ?? '')[0]).toBe('jitter       1040 ms ▲  ');
  const compact = metrics(sat, C80, G, false).map(strip);
  expect(compact[2]?.slice(2, 25)).toBe('internet    12000 12000');
});

// ---- footer shedding (UI-3) ----------------------------------------------------

test('footer sheds the probe rate before the transient message', () => {
  const msg = 'speed test: 22 Mbps down';
  const f80 = footer(makeSnapshot(), ui({ footerMsg: msg, footerMsgUntil: null }), 80)[0] ?? '';
  expect(visibleWidth(f80)).toBe(80);
  expect(f80).toContain(msg);
  expect(f80).toContain('o portal');
  expect(f80).not.toContain('probes');
  const short = footer(makeSnapshot(), ui({ footerMsg: 'no point testing while down', footerMsgUntil: null }), 80)[0] ?? '';
  expect(short).toContain('no point testing while down');
  // with --log the log status is kept (§10); the probe rate goes first
  const log = footer(makeSnapshot(), ui({ footerMsg: msg, footerMsgUntil: null, logStatus: 'on' }), 100)[0] ?? '';
  expect([log.includes(msg), log.endsWith('log: on'), visibleWidth(log)]).toEqual([true, true, 100]);
  // a message too long for the row is cut, never dropped, and the keys stay whole
  const long = footer(makeSnapshot(), ui({ footerMsg: 'opening http://captive.apple.com/hotspot-detect.html', footerMsgUntil: null }), 80)[0] ?? '';
  expect([long.includes('o portal'), long.includes('opening http://captive'), visibleWidth(long)]).toEqual([true, true, 80]);
  expect(ASCII_RE.test(long)).toBe(true);
  // no message: the probe rate stays; the size hint is what goes first
  expect(footer(makeSnapshot(), ui(), 80)[0]).toContain('  t speed test  ');
  expect(footer(makeSnapshot(), ui(), 72)[0]?.endsWith('probes ~1.2 MB/h')).toBe(true);
});

// ---- timeline markers near `now` (UI-5) ----------------------------------------

test('timeline: a fresh drop never collides with the `now` label', () => {
  for (const age of [10, 20, 34, 42]) {
    const open = makeOutage({ n: 4, cause: 'uplink', startedAt: wallAt('14:32:07') - age * 1000, endedAt: null, durationS: age });
    const r = strip(timeline(makeSnapshot({ openOutage: open, state: 'DOWN', downFor: age }), FULL, G, false)[1] ?? '').slice(10);
    expect([age, r.slice(87)]).toEqual([age, 'now']);
    expect([age, r[86]]).toEqual([age, ' ']);
    expect(r.includes('▲now')).toBe(false);
    if (age === 42) expect(r[85]).toBe('▲'); // room for the bare arrow, one cell clear of `now`
  }
});

test('timeline: a marker that loses a collision shrinks to its stamp, never a fragment', () => {
  const r = strip(timeline(makeSnapshot(), C80, G, false)[1] ?? '').slice(10);
  expect(r.slice(7, 16)).toBe('▲14:19   '); // full text would run into the 14:21 marker at cell 16
  expect(r.slice(16, 29)).toBe('▲14:21 portal');
});

test('timeline: a drop in the first cells hides the -15m label instead of leaving a fragment', () => {
  const plan = { cols: 40, timelineCells: 30, cellMs: 30000 };
  const r = strip(timeline(makeSnapshot(), plan, G, false)[1] ?? '').slice(10);
  expect(r).not.toMatch(/-1\d?▲/);
  expect(r.startsWith('   ▲')).toBe(true);
  expect(strip(timeline(makeSnapshot(), FULL, G, false)[1] ?? '').slice(10).startsWith('-15m')).toBe(true);
});
