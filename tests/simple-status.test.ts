import { test, expect } from 'bun:test';
import { status } from '../src/ui/sections/status';
import { simpleHeader } from '../src/ui/sections/header';
import { ellipsize, shedRight } from '../src/ui/sections/common';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { FLAT_TREND, makeGrade, makeRoute, makeSnapshot } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ui = (o: Partial<UiState> = {}): UiState => ({
  view: 'simple', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null, ...o,
});
const SENTENCE = 'Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no (3 drops/15m).';

test('shedRight keeps whole segments from the left; ellipsize marks a cut', () => {
  expect(shedRight(['aa', 'bb', 'cc'], ' | ', 7)).toBe('aa | bb');
  expect(shedRight(['toolong'], ' | ', 3)).toBe('toolong'); // the first segment is never shed
  expect(ellipsize('abcdef', 4, G)).toBe('abc…');
  expect(ellipsize('abc', 4, G)).toBe('abc');
  expect(ellipsize('abcdef', 5, A)).toBe('ab...');
});

test('status UP: badge, grade, steady, trend; sentence on row 2', () => {
  const rows = status(makeSnapshot({ banner: ['', SENTENCE] }), ui(), 100, G, false);
  expect(rows.map((r) => visibleWidth(r))).toEqual([100, 100]);
  expect(rows[0]?.trimEnd()).toBe('  ● UP   OK (B)   steady 4m12s   getting worse ▲');
  expect(rows[1]?.trimEnd()).toBe(`  ${SENTENCE}`);
});

test('status sheds row-1 segments from the right and ellipsizes the sentence', () => {
  const rows = status(makeSnapshot({ banner: ['', SENTENCE] }), ui(), 40, G, false);
  expect(rows[0]?.trimEnd()).toBe('  ● UP   OK (B)   steady 4m12s');
  expect(rows[1]?.endsWith('…')).toBe(true);
  expect(visibleWidth(rows[1] ?? '')).toBe(40);
});

test('status DOWN: cause and outage clock, no grade', () => {
  const snap = makeSnapshot({ state: 'DOWN', cause: 'uplink', downFor: 42, grade: makeGrade({ grade: null }), trend: FLAT_TREND });
  expect(status(snap, ui(), 80, G, false)[0]?.trimEnd()).toBe('  ● DOWN   uplink   DOWN 0:42');
});

test('status with color: the badge is an inverse colored block; flash inverts the row instead', () => {
  const on = status(makeSnapshot(), ui(), 80, G, true)[0] ?? '';
  expect(on).toContain('\x1b[7m\x1b[1m\x1b[32m UP \x1b[39m\x1b[22m\x1b[27m');
  const flash = status(makeSnapshot(), ui({ flashTicksLeft: 2 }), 80, G, true)[0] ?? '';
  expect(flash.startsWith('\x1b[7m')).toBe(true);
  expect(flash.split('\x1b[7m').length - 1).toBe(1); // only the row's own inverse
});

test('status without color keeps the state readable (● UP / * UP in ascii)', () => {
  expect(strip(status(makeSnapshot(), ui(), 80, A, false)[0] ?? '')).toContain('* UP');
  expect(status(makeSnapshot(), ui(), 80, G, false)[0]).not.toContain('\x1b[');
});

test('simpleHeader: name, link and clock only', () => {
  const [h] = simpleHeader(makeSnapshot(), 80, G, false);
  expect(visibleWidth(h ?? '')).toBe(80);
  expect(h?.startsWith(' netmon  Wi-Fi (en1)')).toBe(true);
  expect(h?.endsWith('14:32:07')).toBe(true);
  expect(h).not.toContain('gw ');
  const [eth] = simpleHeader(makeSnapshot({ wifiStatus: 'off', route: makeRoute({ egressIface: 'en7' }) }), 80, G, false);
  expect(eth?.startsWith(' netmon  en7 ')).toBe(true);
  expect(eth).not.toContain('Wi-Fi');
  const [vpn] = simpleHeader(makeSnapshot({ vpn: true }), 80, G, false);
  expect(vpn).toContain('Wi-Fi (en1) · vpn');
});
