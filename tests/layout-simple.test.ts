import { test, expect } from 'bun:test';
import { planSimpleLayout, simpleTimeline } from '../src/ui/layout-simple';
import { planLayout, slotFor, tooSmallMessage, type LayoutPlan } from '../src/ui/layout';
import { composeLines } from '../src/ui/frame';

function occupied(plan: LayoutPlan): number[] {
  const rows: number[] = [...plan.rules];
  for (const s of plan.slots) for (let i = 0; i < s.rows; i++) rows.push(s.row + i);
  return rows.sort((a, b) => a - b);
}

function expectSane(plan: LayoutPlan): void {
  const occ = occupied(plan);
  expect(new Set(occ).size).toBe(occ.length);
  for (const r of occ) expect(r >= 1 && r <= plan.rows).toBe(true);
  expect(slotFor(plan, 'footer')?.row).toBe(plan.rows);
  expect(plan.chartRows).toBeLessThanOrEqual(14);
}

const ALL = ['header', 'status', 'chips', 'chain', 'chart', 'timeline', 'tip', 'footer'];

test('80x24: every section, six spacers, chart 7', () => {
  const p = planSimpleLayout({ cols: 80, rows: 24 });
  expect([p.view, p.tooSmall]).toEqual(['simple', false]);
  expect(p.sections).toEqual(ALL);
  expect(p.chartRows).toBe(7);
  expect(p.rules).toEqual([2, 5, 8, 10, 18, 22]);
  expect(slotFor(p, 'chart')).toEqual({ id: 'chart', row: 11, rows: 7 });
  expect(slotFor(p, 'timeline')).toEqual({ id: 'timeline', row: 19, rows: 3 });
  expectSane(p);
});

test('100x30: chart takes the leftover rows (13)', () => {
  const p = planSimpleLayout({ cols: 100, rows: 30 });
  expect(p.chartRows).toBe(13);
  expect(p.rules).toEqual([2, 5, 8, 10, 24, 28]);
  expectSane(p);
});

test('60x15: chart at its minimum, no spacers', () => {
  const p = planSimpleLayout({ cols: 60, rows: 15 });
  expect(p.sections).toEqual(ALL);
  expect([p.chartRows, p.rules]).toEqual([4, []]);
  expectSane(p);
});

test('40x10: no chart, no tip, no spacers', () => {
  const p = planSimpleLayout({ cols: 40, rows: 10 });
  expect(p.sections).toEqual(['header', 'status', 'chips', 'chain', 'timeline', 'footer']);
  expect([p.chartRows, p.rules]).toEqual([0, []]);
  expectSane(p);
});

test('160x50: chart capped at 14, the rest stays blank above the footer', () => {
  const p = planSimpleLayout({ cols: 160, rows: 50 });
  expect(p.chartRows).toBe(14);
  expect(slotFor(p, 'tip')?.row).toBe(30);
  expectSane(p);
});

test('below 40x10 only the message is shown', () => {
  for (const size of [{ cols: 39, rows: 10 }, { cols: 40, rows: 9 }]) {
    const p = planSimpleLayout(size);
    expect([p.tooSmall, p.slots]).toEqual([true, []]);
    expect(tooSmallMessage(p)).toBe('too small (need 40x10)');
    expect(composeLines(p, {}, '')[0]).toBe('too small (need 40x10)');
  }
});

test('advanced plan: view advanced, no chart; its too-small message points at v', () => {
  const p = planLayout({ cols: 60, rows: 15 });
  expect([p.view, p.chartRows, p.tooSmall]).toEqual(['advanced', 0, true]);
  expect(tooSmallMessage(p)).toBe('details need 72x18 (have 60x15); press v');
});

test('simpleTimeline: fills the row up to 90 cells, always ~15 minutes', () => {
  expect(simpleTimeline(40)).toEqual({ cells: 30, cellMs: 30000 });
  expect(simpleTimeline(80)).toEqual({ cells: 70, cellMs: 12857 });
  expect(simpleTimeline(100)).toEqual({ cells: 90, cellMs: 10000 });
  expect(simpleTimeline(160)).toEqual({ cells: 90, cellMs: 10000 });
});

test('every size from 40x10 to 160x50 plans without overlap', () => {
  for (let cols = 40; cols <= 160; cols += 13) {
    for (let rows = 10; rows <= 50; rows++) expectSane(planSimpleLayout({ cols, rows }));
  }
});

test('spacer rows compose as blank lines', () => {
  const p = planSimpleLayout({ cols: 80, rows: 24 });
  const lines = composeLines(p, { header: ['H'], status: ['S1', 'S2'], footer: ['F'] }, '');
  expect([lines[0], lines[1], lines[2], lines[23]]).toEqual(['H', '', 'S1', 'F']);
});
