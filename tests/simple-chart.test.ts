import { test, expect } from 'bun:test';
import { barColor, barEighths, chart, niceTop } from '../src/ui/sections/chart';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { makeSnapshot, makeUi } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;
const ui = makeUi;

test('niceTop: 50, 100, 200, 500, 1000, … never below 50', () => {
  expect([0, 49, 50, 51, 999, 1000, 1001, 12000].map(niceTop)).toEqual([50, 50, 50, 100, 1000, 1000, 2000, 20000]);
  expect([Number.NaN, Number.POSITIVE_INFINITY].map(niceTop)).toEqual([50, 50]);
});

test('barEighths: proportional, at least 1 for a reply, capped at the plot', () => {
  expect([barEighths(100, 4, 200), barEighths(0, 4, 200), barEighths(1, 4, 1000), barEighths(5000, 4, 200)]).toEqual([16, 0, 1, 32]);
});

test('barColor: §7.2 tier bands after the satellite offset', () => {
  expect([300, 301, 800, 801].map((v) => barColor(v, 0))).toEqual(['green', 'yellow', 'yellow', 'red']);
  expect(barColor(650, 400)).toBe('green');
});

test('plot: newest at the right, eighth blocks, x for lost, axis labels', () => {
  const snap = makeSnapshot({ rttHistory: [100, 200, null, 50], speed: null });
  const lines = chart(snap, ui(), 60, 5, G, false);
  expect(lines.length).toBe(5);
  expect(lines[0]?.startsWith('  LATENCY  48ms typical · 86ms peaks')).toBe(true);
  expect(lines[0]?.endsWith('last 4s')).toBe(true);
  expect(lines.slice(1).map((l) => l.trimEnd())).toEqual(['  200┤ █', '     ┤ █', '  100┤██', '     ┤██x█']);
});

test('bar colors per sample; lost samples red', () => {
  // top 1000, 3 plot rows: 100 → 2 eighths (▂), 500 and 900 fill the bottom row
  const bottom = chart(makeSnapshot({ rttHistory: [100, 500, 900], speed: null }), ui(), 60, 4, G, true)[3] ?? '';
  expect(bottom).toContain('\x1b[32m▂\x1b[39m');
  expect(bottom).toContain('\x1b[33m█\x1b[39m');
  expect(bottom).toContain('\x1b[31m█\x1b[39m');
  const lost = chart(makeSnapshot({ rttHistory: [50, null, 50], speed: null }), ui(), 60, 4, G, true)[3] ?? '';
  expect(lost).toContain('\x1b[31mx\x1b[39m');
});

test('narrow: only the newest samples that fit; wide: two columns per sample', () => {
  // mock history tops at 58 → axis 100 (4 cells); 60 cols leave 54 plot columns, 40 cols leave 34
  expect(chart(makeSnapshot({ speed: null }), ui(), 60, 4, G, false)[0]?.endsWith('last 54s')).toBe(true);
  const narrow = chart(makeSnapshot({ speed: null }), ui(), 40, 4, G, false);
  expect(visibleWidth((narrow[3] ?? '').trimEnd())).toBe(40); // the caption's right side is dropped here
  const wide = chart(makeSnapshot({ speed: null }), ui(), 130, 4, G, false);
  expect(visibleWidth((wide[3] ?? '').trimEnd())).toBe(2 + 4 + 120);
});

test('warmup and blocked ping: caption only, plot rows blank', () => {
  const warm = chart(makeSnapshot({ rttHistory: [] }), ui(), 60, 4, G, false);
  expect(warm[0]).toContain('LATENCY  measuring…');
  expect(warm.slice(1).every((l) => l.trim() === '')).toBe(true);
  const blocked = chart(makeSnapshot({ icmpBlocked: true, rttProxyMs: 310 }), ui(), 80, 4, G, false);
  expect(blocked[0]).toContain('LATENCY  310ms via web checks (ping blocked)');
  expect(blocked.slice(1).every((l) => l.trim() === '')).toBe(true);
});

test('all lost: "no replies" and a row of x along the bottom', () => {
  const lines = chart(makeSnapshot({ rttHistory: new Array(10).fill(null), latencyMs: null, latencyP95: null, speed: null }), ui(), 60, 4, G, false);
  expect(lines[0]).toContain('LATENCY  no replies');
  expect(lines[3]?.trimEnd().endsWith('x'.repeat(10))).toBe(true);
});

test('satellite: raw-ms axis, caption says satellite, bars green after the offset', () => {
  const snap = makeSnapshot({ sat: true, rttOffset: 500, rttHistory: [600, 600, 600], latencyMs: 600, latencyP95: 640, speed: null });
  const lines = chart(snap, ui(), 60, 4, G, true);
  expect(strip(lines[0] ?? '')).toContain('· satellite');
  expect(strip(lines[1] ?? '').startsWith('  1000┤')).toBe(true);
  expect(lines[3]).toContain('\x1b[32m');
});

test('extreme RTTs: a 12000 ms spike widens the axis but never the row', () => {
  const snap = makeSnapshot({ rttHistory: [40, 12000, 45], latencyMs: 45, latencyP95: 12000, speed: null });
  const lines = chart(snap, ui(), 40, 6, G, true);
  expect(strip(lines[1] ?? '').startsWith('  20000┤')).toBe(true);
  for (const l of lines) expect(visibleWidth(l)).toBe(40);
});

test('caption right side: speed test result, or running', () => {
  expect(strip(chart(makeSnapshot(), ui(), 80, 4, G, true)[0] ?? '')).toContain('speed test 12m ago:');
  expect(chart(makeSnapshot(), ui({ speedRunning: true }), 80, 4, G, false)[0]?.endsWith('speed test running…')).toBe(true);
});

test('every size: exactly rows lines of exactly cols cells; ascii stays ASCII', () => {
  for (const cols of [40, 60, 80, 100, 130, 160]) {
    for (let rows = 1; rows <= 14; rows++) {
      const lines = chart(makeSnapshot({ rttHistory: [5, null, 900, 40] }), ui(), cols, rows, G, true);
      expect(lines.length).toBe(rows);
      for (const l of lines) expect(visibleWidth(l)).toBe(cols);
    }
  }
  for (const l of chart(makeSnapshot({ speed: null }), ui(), 80, 7, A, false)) expect(ASCII_RE.test(l)).toBe(true);
});

test('the axis scale comes from the samples drawn, not from hidden older ones', () => {
  // 60 cols draw the newest 53–54 samples; a 4000 ms reply among the oldest must not flatten them
  const snap = makeSnapshot({ rttHistory: [4000, ...new Array<number>(59).fill(50)], speed: null });
  const lines = chart(snap, ui(), 60, 6, G, false);
  expect(lines[1]).toContain('50┤');
  expect(lines.join('\n')).not.toContain('5000');
});

test('the middle axis label is half the top, on the row that holds the half level', () => {
  // 5 plot rows, top 100: half (50) lies inside row 2 (from the top)
  const lines = chart(makeSnapshot({ rttHistory: [40, 58, 45], speed: null }), ui(), 60, 6, G, false);
  expect(lines.slice(1).map((l) => l.trimEnd().replace(/[█▁▂▃▄▅▆▇ ]+$/, ''))).toEqual(['  100┤', '     ┤', '   50┤', '     ┤', '     ┤']);
});

test('the left caption is dim like the rest of the chart text (spec §5)', () => {
  expect(chart(makeSnapshot({ rttHistory: [] }), ui(), 60, 4, G, true)[0]).toContain('\x1b[2mLATENCY  measuring…');
});
