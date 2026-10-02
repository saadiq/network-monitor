import { test, expect } from 'bun:test';
import { frameLines } from '../src/app/render';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState, View } from '../src/model/types';
import { makeSnapshot, makeUi, makeVerdicts } from './helpers/snapshot';

const ASCII_RE = /^[\x00-\x7f]*$/;
// the fixture's video reason has a literal '·'; real verdicts use g.sep, which is '|' in --ascii
const asciiSnap = () => makeSnapshot({ verdicts: makeVerdicts({ 'VIDEO CALL': { reason: 'jitter 71ms | audio ok' } }) });
const ui = (view: View): UiState => makeUi({ view });
const SIZES = [{ cols: 40, rows: 10 }, { cols: 60, rows: 15 }, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 160, rows: 50 }];

test('every view x size x glyph set: exactly rows lines, none wider than cols', () => {
  for (const view of ['simple', 'advanced'] as View[]) {
    for (const size of SIZES) {
      for (const ascii of [false, true]) {
        for (const colorOn of [false, true]) {
          const lines = frameLines(ascii ? asciiSnap() : makeSnapshot(), ui(view), size, glyphs(ascii), colorOn);
          expect(lines.length).toBe(size.rows);
          for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(size.cols);
          if (ascii && !colorOn) for (const l of lines) expect(ASCII_RE.test(l)).toBe(true);
        }
      }
    }
  }
});

test('simple 80x24 matches the spec layout', () => {
  const lines = frameLines(makeSnapshot(), ui('simple'), { cols: 80, rows: 24 }, glyphs(false), false).map(strip);
  expect(lines[0]?.startsWith(' netmon  Wi-Fi (en1)')).toBe(true);
  expect(lines[1]).toBe('');
  expect(lines[2]?.startsWith('  ● UP   OK (B)')).toBe(true);
  expect(lines[5]?.indexOf('✔ Chat')).toBe(2);
  expect(lines[8]?.startsWith('  Wi-Fi ✔────')).toBe(true);
  expect(lines[10]?.startsWith('  LATENCY  48ms typical')).toBe(true);
  expect(lines[18]?.startsWith(' LAST 15m ')).toBe(true);
  expect(lines[20]?.startsWith('  3 drops · usually ~22s')).toBe(true);
  expect(lines[23]?.startsWith('  v details')).toBe(true);
});

test('advanced view is today\'s screen plus v simple', () => {
  const lines = frameLines(makeSnapshot(), ui('advanced'), { cols: 100, rows: 30 }, glyphs(false), false).map(strip);
  expect(lines[0]).toContain('gw 192.168.0.1');
  expect(lines[29]).toContain('v simple');
});

test('too small: each view shows its own message', () => {
  expect(frameLines(makeSnapshot(), ui('simple'), { cols: 39, rows: 10 }, glyphs(false), false)[0]).toBe('too small (need 40x10)');
  expect(frameLines(makeSnapshot(), ui('advanced'), { cols: 60, rows: 15 }, glyphs(false), false)[0])
    .toBe('details need 72x18 (have 60x15); press v');
});
