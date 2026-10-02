import { test, expect } from 'bun:test';
import { planLayout, tooSmallMessage, slotFor, type LayoutPlan } from '../src/ui/layout';
import { composeLines, fitLine, renderFrame, ruleLine, FrameGate } from '../src/ui/frame';
import { color, glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';

const ROW_RE = /\x1b\[(\d+);1H/g;

/** Split a frame into its per-row payloads (after the `ESC[r;1H` + `ESC[K` prefix). */
function frameRows(frame: string): string[] {
  expect(frame.startsWith('\x1b[H')).toBe(true);
  const parts = frame.slice(3).split(/\x1b\[\d+;1H\x1b\[K/);
  expect(parts[0]).toBe('');
  return parts.slice(1);
}

function occupiedRows(plan: LayoutPlan): number[] {
  const rows: number[] = [...plan.rules];
  for (const s of plan.slots) for (let i = 0; i < s.rows; i++) rows.push(s.row + i);
  return rows.sort((a, b) => a - b);
}

function expectSane(plan: LayoutPlan): void {
  const occ = occupiedRows(plan);
  expect(new Set(occ).size).toBe(occ.length); // no overlaps
  for (const r of occ) expect(r >= 1 && r <= plan.rows).toBe(true);
  expect(slotFor(plan, 'footer')?.row).toBe(plan.rows); // footer pinned to the last row
  expect(plan.sections).toEqual(plan.slots.map((s) => s.id));
}

test('100x30 full layout: every section, 7 rules, footer on row 30', () => {
  const p = planLayout({ cols: 100, rows: 30 });
  expect(p.tooSmall).toBe(false);
  expect(p.compact).toBe(false);
  expect(p.sections).toEqual(['header', 'banner', 'activities', 'path', 'metrics', 'timeline', 'drops', 'tip', 'footer']);
  expect(p.activitiesRows).toBe(1);
  expect(p.dropsRows).toBe(4);
  expect(p.timelineCells).toBe(90);
  expect(p.cellMs).toBe(10000);
  expect(p.rules).toEqual([2, 5, 7, 9, 16, 19, 24]);
  expect(slotFor(p, 'metrics')).toEqual({ id: 'metrics', row: 10, rows: 6 });
  expect(slotFor(p, 'tip')).toEqual({ id: 'tip', row: 25, rows: 1 });
  expect(occupiedRows(p).length).toBe(26); // 4 spare rows sit blank above the footer
  expectSane(p);
});

test('100x27 is the smallest full layout', () => {
  const p = planLayout({ cols: 100, rows: 27 });
  expect(p.compact).toBe(false);
  expect(p.rules.length).toBe(7);
  expect(p.sections.length).toBe(9);
  expect(slotFor(p, 'footer')?.row).toBe(27);
  expectSane(p);
});

test('80x24 compact layout: 2-row activities, 3-row drops, 60 cells, 5 rules', () => {
  const p = planLayout({ cols: 80, rows: 24 });
  expect(p.tooSmall).toBe(false);
  expect(p.compact).toBe(true);
  expect(p.sections).toEqual(['header', 'banner', 'activities', 'path', 'metrics', 'timeline', 'drops', 'tip', 'footer']);
  expect(p.activitiesRows).toBe(2);
  expect(p.dropsRows).toBe(3);
  expect(p.timelineCells).toBe(60);
  expect(p.cellMs).toBe(15000);
  expect(p.rules).toEqual([2, 8, 15, 18, 22]);
  expect(slotFor(p, 'activities')).toEqual({ id: 'activities', row: 5, rows: 2 });
  expect(slotFor(p, 'tip')?.row).toBe(23);
  expect(occupiedRows(p).length).toBe(24);
  expectSane(p);
});

test('72x18 minimum: everything but the tip, no rules, exactly 18 rows', () => {
  const p = planLayout({ cols: 72, rows: 18 });
  expect(p.tooSmall).toBe(false);
  expect(p.compact).toBe(true);
  expect(p.sections).toEqual(['header', 'banner', 'activities', 'path', 'metrics', 'timeline', 'drops', 'footer']);
  expect(p.rules).toEqual([]);
  expect(occupiedRows(p).length).toBe(18);
  expect(slotFor(p, 'drops')).toEqual({ id: 'drops', row: 15, rows: 3 });
  expectSane(p);
});

test('60x16 is too small', () => {
  const p = planLayout({ cols: 60, rows: 16 });
  expect(p.tooSmall).toBe(true);
  expect(p.sections).toEqual([]);
  expect(p.slots).toEqual([]);
  expect(p.rules).toEqual([]);
  expect(tooSmallMessage(p)).toBe('details need 72x18 (have 60x16); press v');
  expect(planLayout({ cols: 120, rows: 17 }).tooSmall).toBe(true);
  expect(planLayout({ cols: 71, rows: 40 }).tooSmall).toBe(true);
});

test('100x24: compact by rows only — 1-row activities, 90 cells, 3-row drops', () => {
  const p = planLayout({ cols: 100, rows: 24 });
  expect(p.compact).toBe(true);
  expect(p.activitiesRows).toBe(1);
  expect(p.dropsRows).toBe(3);
  expect(p.timelineCells).toBe(90);
  expect(p.rules).toEqual([2, 7, 14, 17, 21]);
  expectSane(p);
});

test('every size from 72x18 to 140x50 plans without overlap', () => {
  for (let cols = 72; cols <= 140; cols += 17) {
    for (let rows = 18; rows <= 50; rows += 1) expectSane(planLayout({ cols, rows }));
  }
});

test('fitLine: exactly cols visible cells, ANSI-aware, control chars dropped', () => {
  expect(fitLine('abc', 6)).toBe('abc   ');
  expect(fitLine('abcdefgh', 4)).toBe('abcd');
  expect(fitLine('a\tb\nc\rd', 6)).toBe('abcd  ');
  const styled = fitLine(color('green', 'hello', true) + ' world', 8);
  expect(strip(styled)).toBe('hello wo');
  expect(visibleWidth(styled)).toBe(8);
  expect(styled.endsWith('\x1b[0m')).toBe(true);
  expect(fitLine('日本語', 4)).toBe('日本'); // wide char boundary: never exceeds cols
  expect(fitLine('x', 0)).toBe('');
});

test('renderFrame: home, one ESC[r;1H ESC[K per row, every row fitted to cols', () => {
  const size = { cols: 20, rows: 5 };
  const frame = renderFrame(['one', 'two ' + color('red', 'x'.repeat(30), true), '三四五', '', 'five', 'six (dropped)'], size);
  const rows = frameRows(frame);
  expect(rows.length).toBe(5);
  expect((frame.match(ROW_RE) ?? []).map((m) => m.replace(ROW_RE, '$1'))).toEqual(['1', '2', '3', '4', '5']);
  for (const r of rows) {
    expect(strip(r).length <= size.cols).toBe(true);
    expect(visibleWidth(r) <= size.cols).toBe(true);
  }
  expect(strip(rows[0] ?? '')).toBe('one'.padEnd(20));
  expect(strip(rows[1] ?? '')).toBe('two ' + 'x'.repeat(16));
  expect(rows[1]?.includes('\x1b[31m')).toBe(true);
  expect(strip(rows[4] ?? '')).toBe('five'.padEnd(20));
  expect(frame.includes('\x1b[2J')).toBe(false); // never a full clear
  expect(frame.includes('\n')).toBe(false);
});

test('renderFrame pads missing rows and tolerates degenerate sizes', () => {
  expect(frameRows(renderFrame([], { cols: 10, rows: 3 }))).toEqual([' '.repeat(10), ' '.repeat(10), ' '.repeat(10)]);
  expect(frameRows(renderFrame(['x'], { cols: 0, rows: 0 })).length).toBe(1);
});

test('composeLines: sections at their slots, rules where planned, footer last, tip row', () => {
  const size = { cols: 80, rows: 24 };
  const plan = planLayout(size);
  const g = glyphs(false);
  const rule = ruleLine(size.cols, g.rule);
  const lines = composeLines(plan, {
    header: ['HEADER'],
    banner: ['B1', 'B2'],
    activities: ['A1', 'A2', 'A3 (extra, dropped)'],
    path: ['PATH'],
    metrics: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'],
    timeline: ['T1', 'T2'],
    drops: ['D1', 'D2', 'D3', 'D4 (dropped at < 27 rows)'],
    tip: ['TIP'],
    footer: ['FOOTER'],
  }, rule);
  expect(lines.length).toBe(24);
  expect(lines[0]).toBe('HEADER');
  expect(lines[1]).toBe(rule);
  expect(lines[2]).toBe('B1');
  expect(lines[3]).toBe('B2');
  expect(lines[4]).toBe('A1');
  expect(lines[5]).toBe('A2');
  expect(lines[6]).toBe('PATH');
  expect(lines[7]).toBe(rule);
  expect(lines.slice(8, 14)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  expect(lines[14]).toBe(rule);
  expect(lines[15]).toBe('T1');
  expect(lines[16]).toBe('T2');
  expect(lines[17]).toBe(rule);
  expect(lines.slice(18, 21)).toEqual(['D1', 'D2', 'D3']);
  expect(lines[21]).toBe(rule);
  expect(lines[22]).toBe('TIP');
  expect(lines[23]).toBe('FOOTER');
  expect(rule).toBe('─'.repeat(80));
  const frame = renderFrame(lines, size);
  for (const r of frameRows(frame)) expect(visibleWidth(r)).toBe(80);
});

test('composeLines: short sections are padded with blanks; spare rows above the footer are blank', () => {
  const plan = planLayout({ cols: 100, rows: 30 });
  const lines = composeLines(plan, { header: ['H'], metrics: ['M1'], footer: ['F'] }, ruleLine(100, '─'));
  expect(lines.length).toBe(30);
  expect(lines[9]).toBe('M1');
  expect(lines.slice(10, 15)).toEqual(['', '', '', '', '']);
  expect(lines.slice(25, 29)).toEqual(['', '', '', '']);
  expect(lines[29]).toBe('F');
});

test('composeLines: too-small plan yields the single message line', () => {
  const plan = planLayout({ cols: 60, rows: 16 });
  const lines = composeLines(plan, { header: ['H'], footer: ['F'] }, ruleLine(60, '─'));
  expect(lines.length).toBe(16);
  expect(lines[0]).toBe('details need 72x18 (have 60x16); press v');
  expect(lines.slice(1).every((l) => l === '')).toBe(true);
  const rows = frameRows(renderFrame(lines, { cols: 60, rows: 16 }));
  expect(rows.length).toBe(16);
  expect(strip(rows[0] ?? '').trimEnd()).toBe('details need 72x18 (have 60x16); press v');
});

test('ascii mode: rule and frame stay pure ASCII', () => {
  const g = glyphs(true);
  const plan = planLayout({ cols: 72, rows: 20 });
  const lines = composeLines(plan, { header: ['netmon'], footer: ['q quit'] }, ruleLine(72, g.rule));
  const frame = renderFrame(lines, { cols: 72, rows: 20 });
  expect(ruleLine(72, g.rule)).toBe('-'.repeat(72));
  // eslint-disable-next-line no-control-regex
  expect(/^[\x00-\x7f]*$/.test(frame)).toBe(true);
  expect(frame.includes('\x1b[0m')).toBe(false); // unstyled lines get no reset appended
});

test('FrameGate caps writes at 4 per second and reports the wait', () => {
  const gate = new FrameGate();
  expect(gate.delay(1000)).toBe(0);
  expect(gate.delay(1100)).toBe(150);
  expect(gate.delay(1249)).toBe(1);
  expect(gate.delay(1250)).toBe(0);
  gate.mark(2000);
  expect(gate.delay(2100)).toBe(150);
  expect(gate.delay(3000)).toBe(0);
});
