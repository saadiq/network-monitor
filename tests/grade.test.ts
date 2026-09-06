import { test, expect } from 'bun:test';
import { rawGrade, applyCaps, GradeHold, gradeInputs, computeGrade } from '../src/model/grade';
import { updateSat, adjustRtt, SAT_OFF, satOffset } from '../src/model/satellite';
import type { GradeInputs, CapContext } from '../src/model/grade';

const inp = (o: Partial<GradeInputs> = {}): GradeInputs => ({ loss: 0, rtt: 50, p95: 80, jitter: 10, ...o });
const ctx = (o: Partial<CapContext> = {}): CapContext => ({
  sinceLastDrop: null, drops15: 0, loss300: 0, icmpBlocked: false, underLoad: false, ...o,
});

// ---- §7.2 tiers -----------------------------------------------------------------

test('A at exactly the A limits; one step over each limit drops to B', () => {
  expect(rawGrade(inp({ loss: 1, rtt: 150, p95: 300, jitter: 30 }))).toBe('A');
  expect(rawGrade(inp({ loss: 1.01 }))).toBe('B');
  expect(rawGrade(inp({ rtt: 151 }))).toBe('B');
  expect(rawGrade(inp({ p95: 301 }))).toBe('B');
  expect(rawGrade(inp({ jitter: 31 }))).toBe('B');
});

test('B at exactly the B limits; one step over drops to C', () => {
  expect(rawGrade(inp({ loss: 5, rtt: 300, p95: 600, jitter: 60 }))).toBe('B');
  expect(rawGrade(inp({ loss: 5.1 }))).toBe('C');
  expect(rawGrade(inp({ rtt: 301 }))).toBe('C');
  expect(rawGrade(inp({ p95: 601 }))).toBe('C');
  expect(rawGrade(inp({ jitter: 61 }))).toBe('C');
});

test('C at exactly the C limits; one step over is D', () => {
  expect(rawGrade(inp({ loss: 15, rtt: 800, p95: 1500, jitter: 150 }))).toBe('C');
  expect(rawGrade(inp({ loss: 15.1 }))).toBe('D');
  expect(rawGrade(inp({ rtt: 801 }))).toBe('D');
  expect(rawGrade(inp({ p95: 1501 }))).toBe('D');
  expect(rawGrade(inp({ jitter: 151 }))).toBe('D');
  expect(rawGrade(inp({ loss: 100, rtt: 5000, p95: 9000, jitter: 900 }))).toBe('D');
});

test('missing inputs: no RTT → no grade; null loss/p95/jitter are not applied', () => {
  expect(rawGrade(inp({ rtt: null }))).toBeNull();
  expect(rawGrade(inp({ loss: null, p95: null, jitter: null }))).toBe('A');
  expect(rawGrade(inp({ p95: null, rtt: 200 }))).toBe('B'); // icmpBlocked shape
});

test('gradeInputs: satellite offset applies to p50/p95; icmpBlocked swaps sources', () => {
  const inet = { p50: 700, p95: 900, jitter: 20, loss60: 1 };
  const gw = { jitter: 5, loss60: 0 };
  expect(gradeInputs({ inet, gw, icmpBlocked: false, rttProxyMs: null, rttOffset: 600 }))
    .toEqual({ loss: 1, rtt: 100, p95: 300, jitter: 20 });
  expect(gradeInputs({ inet, gw, icmpBlocked: true, rttProxyMs: 120, rttOffset: 600 }))
    .toEqual({ loss: 0, rtt: 120, p95: null, jitter: 5 });
  expect(rawGrade(gradeInputs({ inet, gw, icmpBlocked: false, rttProxyMs: null, rttOffset: 600 }))).toBe('A');
  expect(rawGrade(gradeInputs({ inet, gw, icmpBlocked: false, rttProxyMs: null, rttOffset: 0 }))).toBe('C');
});

// ---- §7.2 caps ------------------------------------------------------------------

test('recent outage (< 120 s) caps at B with a tag; 120 s exactly does not', () => {
  expect(applyCaps('A', ctx({ sinceLastDrop: 119 }))).toEqual({ grade: 'B', tags: ['recent drop'] });
  expect(applyCaps('A', ctx({ sinceLastDrop: 120 }))).toEqual({ grade: 'A', tags: [] });
  expect(applyCaps('C', ctx({ sinceLastDrop: 10 })).grade).toBe('C'); // never improves
});

test('drops15 ≥ 3 caps at B and tags FLAKY', () => {
  expect(applyCaps('A', ctx({ drops15: 3 }))).toEqual({ grade: 'B', tags: ['FLAKY'] });
  expect(applyCaps('A', ctx({ drops15: 2 }))).toEqual({ grade: 'A', tags: [] });
  expect(applyCaps('D', ctx({ drops15: 5 }))).toEqual({ grade: 'D', tags: ['FLAKY'] });
});

test('loss300 > 10 % caps at C', () => {
  expect(applyCaps('A', ctx({ loss300: 10.1 }))).toEqual({ grade: 'C', tags: ['loss 5m'] });
  expect(applyCaps('A', ctx({ loss300: 10 }))).toEqual({ grade: 'A', tags: [] });
  expect(applyCaps('A', ctx({ loss300: null })).grade).toBe('A');
});

test('icmpBlocked caps at B; under load only tags ~', () => {
  expect(applyCaps('A', ctx({ icmpBlocked: true }))).toEqual({ grade: 'B', tags: ['icmp'] });
  expect(applyCaps('A', ctx({ underLoad: true }))).toEqual({ grade: 'A', tags: ['~'] });
});

test('caps combine in spec order and never touch a null grade', () => {
  const all = ctx({ sinceLastDrop: 5, drops15: 4, loss300: 20, icmpBlocked: true, underLoad: true });
  expect(applyCaps('A', all)).toEqual({ grade: 'C', tags: ['recent drop', 'FLAKY', 'loss 5m', 'icmp', '~'] });
  expect(applyCaps(null, all).grade).toBeNull();
  expect(applyCaps(null, all).tags).toContain('FLAKY');
});

// ---- §7.2 hold ------------------------------------------------------------------

test('hold: the displayed grade appears after 5 identical ticks', () => {
  const h = new GradeHold();
  expect(h.push('A')).toBeNull();
  expect(h.push('A')).toBeNull();
  expect(h.push('A')).toBeNull();
  expect(h.push('A')).toBeNull();
  expect(h.push('A')).toBe('A');
  expect(h.grade).toBe('A');
});

test('hold: a change needs 5 consecutive ticks; an interruption restarts the count', () => {
  const h = new GradeHold();
  for (let i = 0; i < 5; i++) h.push('A');
  expect(h.push('B')).toBe('A');
  expect(h.push('B')).toBe('A');
  expect(h.push('B')).toBe('A');
  expect(h.push('B')).toBe('A');
  expect(h.push('A')).toBe('A'); // run broken
  for (let i = 0; i < 4; i++) expect(h.push('B')).toBe('A');
  expect(h.push('B')).toBe('B');
});

test('hold: reset clears the displayed grade and the run', () => {
  const h = new GradeHold();
  for (let i = 0; i < 5; i++) h.push('C');
  h.reset();
  expect(h.grade).toBeNull();
  for (let i = 0; i < 4; i++) expect(h.push('C')).toBeNull();
  expect(h.push('C')).toBe('C');
});

test('computeGrade: graded states push the capped grade; offline/WARMUP reset the hold', () => {
  const h = new GradeHold();
  const c = ctx({ drops15: 3 });
  let g = computeGrade(inp(), c, h, 'UP');
  expect(g).toEqual({ grade: null, raw: 'A', tags: ['FLAKY'], underLoad: false });
  for (let i = 0; i < 4; i++) g = computeGrade(inp(), c, h, 'UP');
  expect(g.grade).toBe('B'); // held = capped
  g = computeGrade(inp(), c, h, 'DOWN');
  expect(g.grade).toBeNull();
  expect(g.raw).toBe('A');
  g = computeGrade(inp(), ctx(), h, 'WARMUP');
  expect(g.grade).toBeNull();
  g = computeGrade(inp(), ctx(), h, 'DEGRADED');
  expect(g.grade).toBeNull(); // hold restarted after leaving the non-graded state
  for (let i = 0; i < 4; i++) g = computeGrade(inp(), ctx(), h, 'DEGRADED');
  expect(g.grade).toBe('A');
});

// ---- §7.1 satellite -------------------------------------------------------------

test('satellite enters at p10 ≥ 400 with loss ≤ 2 %; offset = round50(p10 − 100)', () => {
  expect(updateSat(SAT_OFF, 400, 2, 1000)).toEqual({ sat: true, rttOffset: 300, computedAt: 1000 });
  expect(updateSat(SAT_OFF, 700, 0, 1000).rttOffset).toBe(600);
  expect(updateSat(SAT_OFF, 399, 0, 1000)).toBe(SAT_OFF);
  expect(updateSat(SAT_OFF, 400, 2.1, 1000)).toBe(SAT_OFF);
  expect(updateSat(SAT_OFF, 400, null, 1000)).toBe(SAT_OFF);
  expect(satOffset(124)).toBe(0);
  expect(satOffset(50)).toBe(0);
});

test('satellite exits only below 300 ms; 300–399 keeps the current mode', () => {
  const on = updateSat(SAT_OFF, 700, 0, 1000);
  expect(updateSat(on, 299, 0, 2000)).toEqual(SAT_OFF);
  expect(updateSat(on, 300, 50, 2000).sat).toBe(true); // loss does not exit
  expect(updateSat(SAT_OFF, 350, 0, 2000).sat).toBe(false);
});

test('satellite offset is recomputed every 60 s while on; null p10 keeps the previous state', () => {
  const on = updateSat(SAT_OFF, 700, 0, 1000);
  expect(updateSat(on, 900, 0, 60_999)).toBe(on);
  expect(updateSat(on, 900, 0, 61_000)).toEqual({ sat: true, rttOffset: 800, computedAt: 61_000 });
  expect(updateSat(on, null, null, 200_000)).toBe(on);
  expect(updateSat(SAT_OFF, null, null, 5)).toBe(SAT_OFF);
});

test('adjustRtt subtracts the offset, floors at 0 and passes null through', () => {
  expect(adjustRtt(700, 600)).toBe(100);
  expect(adjustRtt(500, 600)).toBe(0);
  expect(adjustRtt(null, 600)).toBeNull();
  expect(adjustRtt(48, 0)).toBe(48);
});
