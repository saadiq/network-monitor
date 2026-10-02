import { test, expect } from 'bun:test';
import { footer } from '../src/ui/sections/footer';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { makeSnapshot, makeUi } from './helpers/snapshot';

const ui = makeUi;
const f = (w: number, o: Partial<UiState> = {}, snap = makeSnapshot()): string => footer(snap, ui(o), w)[0] ?? '';

test('simple footer: v details first, no probe rate', () => {
  expect(f(80).trimEnd()).toBe('  v details  t speed test  b bell:on  q quit');
  expect(f(100).trimEnd()).toBe('  v details   t speed test   b bell:on   q quit');
  expect(f(80)).not.toContain('probes');
  expect(visibleWidth(f(80))).toBe(80);
});

test('simple footer: o login only while PORTAL', () => {
  expect(f(80, {}, makeSnapshot({ state: 'PORTAL' })).startsWith('  o login  v details')).toBe(true);
  expect(f(80)).not.toContain('o login');
});

test('simple footer at 40 cols: short labels, every key whole', () => {
  expect(f(40).trimEnd()).toBe('  v details  t speed  b bell:on  q quit');
});

test('simple footer keeps the log status and cuts a long message, keys whole', () => {
  expect(f(60, { logStatus: 'on' }).endsWith('log: on')).toBe(true);
  // 40 cols: no room beside the keys, so the message shows alone (never silently dropped)
  const m = f(40, { footerMsg: 'speed test: 22 Mbps down', footerMsgUntil: null });
  expect(visibleWidth(m)).toBe(40);
  expect(m.trimEnd()).toBe('  speed test: 22 Mbps down');
  const r = f(60, { footerMsg: 'speed test: 22 Mbps down', footerMsgUntil: null });
  expect([r.includes('q quit'), r.includes('speed test: 22'), visibleWidth(r)]).toEqual([true, true, 60]);
});

test('advanced footer gains v simple and keeps it at 72 cols', () => {
  const a = footer(makeSnapshot(), ui({ view: 'advanced' }), 72)[0] ?? '';
  expect(a.startsWith('  q quit  t speed  b bell:on  o portal  v simple')).toBe(true);
  expect(a.endsWith('probes ~1.2 MB/h')).toBe(true);
});
