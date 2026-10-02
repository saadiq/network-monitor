import { test, expect } from 'bun:test';
import { chips, cutReason } from '../src/ui/sections/chips';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { allOkVerdicts, makeSnapshot, makeVerdicts } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;

test('80 cols: four 19-cell columns, reasons cut at a " · " under non-OK chips', () => {
  const [top, under] = chips(makeSnapshot(), 80, G, false).map(strip);
  expect([visibleWidth(top ?? ''), visibleWidth(under ?? '')]).toEqual([80, 80]);
  expect([top?.indexOf('✔ Chat'), top?.indexOf('✔ Browse'), top?.indexOf('~ Video call'), top?.indexOf('✘ Download')]).toEqual([2, 21, 40, 59]);
  expect(under?.slice(0, 40).trim()).toBe('');
  expect(under?.indexOf('jitter 71ms')).toBe(40);
  expect(under).not.toContain('audio ok');
  expect(under?.indexOf('3 drops/15m')).toBe(59);
});

test('100 cols: the whole reason fits its 24-cell column', () => {
  const [, under] = chips(makeSnapshot(), 100, G, false);
  expect(under).toContain('jitter 71ms · audio ok');
});

test('Video call shortens to Video only when the full chip does not fit its column', () => {
  expect(chips(makeSnapshot(), 54, G, false)[0]).toContain('~ Video call');
  const [t53] = chips(makeSnapshot(), 53, G, false);
  expect(t53).toContain('~ Video ');
  expect(t53).not.toContain('Video call');
});

test('below 50 cols: a 2x2 grid with no reasons', () => {
  const [r0, r1] = chips(makeSnapshot(), 49, G, false);
  expect([r0?.indexOf('✔ Chat'), r0?.indexOf('✔ Browse')]).toEqual([2, 25]);
  expect([r1?.indexOf('~ Video call'), r1?.indexOf('✘ Download')]).toEqual([2, 25]);
  expect(r1).not.toContain('jitter');
  const [n0, n1] = chips(makeSnapshot(), 40, G, false);
  expect([n0?.trimEnd(), n1?.trimEnd()]).toEqual(['  ' + '✔ Chat'.padEnd(19) + '✔ Browse', '  ' + '~ Video call'.padEnd(19) + '✘ Download']);
});

test('ascii at 50 cols: chips never touch and stay ASCII', () => {
  const rows = chips(makeSnapshot({ verdicts: allOkVerdicts() }), 50, A, false);
  for (const r of rows) expect([visibleWidth(r), ASCII_RE.test(r)]).toEqual([50, true]);
  expect(rows[0]?.indexOf('OK Download')).toBe(38);
  expect(rows[0]?.[37]).toBe(' ');
});

test('chips carry the verdict colors; reasons are dim', () => {
  const [top, under] = chips(makeSnapshot(), 80, G, true);
  expect(top).toContain('\x1b[32m✔ Chat\x1b[39m');
  expect(top).toContain('\x1b[33m~ Video call\x1b[39m');
  expect(top).toContain('\x1b[31m✘ Download\x1b[39m');
  expect(under).toContain('\x1b[2mjitter 71ms\x1b[22m');
  const unknown = chips(makeSnapshot({ verdicts: makeVerdicts({ CHAT: { level: '?' } }) }), 80, G, true)[0];
  expect(unknown).toContain('\x1b[2m? Chat\x1b[22m');
});

test('cutReason: whole when it fits, at a separator, else ellipsized', () => {
  expect(cutReason('3 drops/15m', 18, G)).toBe('3 drops/15m');
  expect(cutReason('jitter 71ms · audio ok', 18, G)).toBe('jitter 71ms');
  expect(cutReason('averyveryverylongreason', 10, G)).toBe('averyvery…');
});
