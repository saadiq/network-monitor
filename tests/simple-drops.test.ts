import { test, expect } from 'bun:test';
import { dropSummary } from '../src/ui/sections/drop-summary';
import { glyphs } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { makeDrops, makeOutage, makeSnapshot, NO_DROPS } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const row = (o: Parameters<typeof makeSnapshot>[0], w = 100, g = G, on = false): string =>
  (dropSummary(makeSnapshot(o), w, g, on)[0] ?? '').trimEnd();

test('recent drops: count, typical length, longest, since last', () => {
  expect(row({})).toBe('  3 drops · usually ~22s · longest 1m04s · last 4m ago');
  expect(row({ drops: makeDrops({ drops15: 1 }) })).toBe('  1 drop · usually ~22s · longest 1m04s · last 4m ago');
});

test('no drops in the session / only earlier drops', () => {
  expect(row({ drops: NO_DROPS })).toBe('  no drops');
  expect(dropSummary(makeSnapshot({ drops: NO_DROPS }), 80, G, true)[0]).toContain('\x1b[32mno drops\x1b[39m');
  expect(row({ drops: makeDrops({ drops15: 0, sinceLastDrop: 2520 }) })).toBe('  no drops in 15m · last 42m ago');
});

test('during an outage: how long drops usually last here', () => {
  const open = makeOutage({ endedAt: null });
  expect(row({ openOutage: open })).toBe('  drops here usually last ~22s · longest 1m04s');
  expect(row({ openOutage: open, drops: NO_DROPS })).toBe('');
});

test('sheds whole segments at narrow widths; ascii separator', () => {
  expect(row({}, 40)).toBe('  3 drops · usually ~22s · longest 1m04s');
  expect(visibleWidth(dropSummary(makeSnapshot(), 40, G, false)[0] ?? '')).toBe(40);
  expect(row({}, 100, A)).toBe('  3 drops | usually ~22s | longest 1m04s | last 4m ago');
});
