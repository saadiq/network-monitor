import { test, expect } from 'bun:test';
import { OutageTracker } from '../src/model/outages';
import type { Cause, State, Transition } from '../src/model/types';

const WALL0 = 1_757_168_000_000;

function tr(from: State, to: State, cause: Cause, at: number, startedAtMono: number): Transition {
  return { from, to, cause, at, wall: WALL0 + at, startedAt: WALL0 + startedAtMono, startedAtMono };
}

function ticks(o: OutageTracker, state: State, fromS: number, toS: number): void {
  for (let t = fromS; t <= toS; t++) o.tick(state, t * 1000);
}

test('open / close: backdated start and end, live durationS, closed list newest first', () => {
  const o = new OutageTracker(0, WALL0);
  ticks(o, 'UP', 1, 13);
  expect(o.onTransition(tr('UP', 'DOWN', 'uplink', 14_000, 10_020))).toBeNull();
  expect(o.open).toMatchObject({ n: 1, state: 'DOWN', cause: 'uplink', startedAt: WALL0 + 10_020, endedAt: null, sleep: false });
  ticks(o, 'DOWN', 14, 30);
  expect(o.open?.durationS).toBe(20);
  expect(o.outages()).toEqual([]);
  const closed = o.onTransition(tr('DOWN', 'UP', null, 31_000, 27_500));
  expect(closed).toMatchObject({ n: 1, cause: 'uplink', startedAt: WALL0 + 10_020, endedAt: WALL0 + 27_500, durationS: 17, sleep: false });
  expect(o.open).toBeNull();
  expect(o.outages()).toHaveLength(1);
  const st = o.stats(31_000);
  expect(st).toMatchObject({ drops15: 1, drops60: 1, dropsSession: 1, dropMedianS: 17, dropLongestS: 17, dropUnder30: 1, dropGapS: null, sinceLastDrop: 3 });
  expect(o.onTransition(tr('UP', 'DEGRADED', 'quality', 40_000, 40_000))).toBeNull();
  expect(o.open).toBeNull();
});

test('cause rewrite: DOWN(uplink) → PORTAL becomes a portal outage; other causes stay fixed', () => {
  const o = new OutageTracker(0, WALL0);
  o.onTransition(tr('UP', 'DOWN', 'uplink', 14_000, 10_020));
  expect(o.onTransition(tr('DOWN', 'PORTAL', 'portal', 16_000, 15_500))).toBeNull();
  expect(o.open).toMatchObject({ n: 1, cause: 'portal', state: 'PORTAL', startedAt: WALL0 + 10_020 });
  const c = o.onTransition(tr('PORTAL', 'UP', null, 40_000, 39_000));
  expect(c).toMatchObject({ cause: 'portal', state: 'PORTAL', durationS: 29 });

  const o2 = new OutageTracker(0, WALL0);
  o2.onTransition(tr('UP', 'DOWN', 'router', 14_000, 10_020));
  o2.onTransition(tr('DOWN', 'PORTAL', 'portal', 16_000, 15_500));
  expect(o2.open).toMatchObject({ cause: 'router', state: 'DOWN' });
  o2.onTransition(tr('PORTAL', 'NO_LINK', 'not-joined', 20_000, 19_500));
  expect(o2.open).toMatchObject({ n: 1, cause: 'router' });
  expect(o2.outages()).toEqual([]);
});

test('median / longest / under-30 / gap / window counts over three drops', () => {
  const o = new OutageTracker(0, WALL0);
  o.onTransition(tr('UP', 'DOWN', 'wifi', 20_000, 16_000));
  o.onTransition(tr('DOWN', 'UP', null, 27_000, 25_000)); // 9 s
  o.onTransition(tr('UP', 'PORTAL', 'portal', 130_000, 128_000));
  o.onTransition(tr('PORTAL', 'UP', null, 195_000, 192_000)); // 64 s
  o.onTransition(tr('UP', 'DOWN', 'uplink', 500_000, 497_000));
  o.onTransition(tr('DOWN', 'DEGRADED', 'dns', 522_000, 519_000)); // 22 s
  expect(o.outages().map((x) => [x.n, x.durationS])).toEqual([[3, 22], [2, 64], [1, 9]]);
  const st = o.stats(600_000);
  expect(st).toMatchObject({
    drops15: 3, drops60: 3, dropsSession: 3, dropMedianS: 22, dropLongestS: 64, dropUnder30: 2, dropGapS: 204, sinceLastDrop: 81,
  });
  const later = o.stats(1_100_000);
  expect(later.drops15).toBe(1);
  expect(later.drops60).toBe(3);
  expect(o.stats(4_100_000).drops60).toBe(0); // last start 497 s < 4100 − 3600 s
});

test('sleep close: onGap closes the open outage at the gap start with sleep=true, excluded from stats', () => {
  const o = new OutageTracker(0, WALL0);
  ticks(o, 'UP', 1, 13);
  o.onTransition(tr('UP', 'DOWN', 'uplink', 14_000, 10_020));
  ticks(o, 'DOWN', 14, 20);
  const c = o.onGap(20_000, 1_400_000);
  expect(c).toMatchObject({ n: 1, sleep: true, endedAt: WALL0 + 20_000, durationS: 10 });
  expect(o.open).toBeNull();
  expect(o.outages()[0]?.sleep).toBe(true);
  const st = o.stats(1_400_000);
  expect(st.dropsSession).toBe(0);
  expect(st.sinceLastDrop).toBeNull();
  expect(st.dropMedianS).toBeNull();
  expect(o.onGap(1_400_000, 1_500_000)).toBeNull();
  // a WARMUP transition arriving with an outage still open closes it as sleep too
  const o2 = new OutageTracker(0, WALL0);
  o2.onTransition(tr('UP', 'DOWN', 'uplink', 14_000, 10_020));
  expect(o2.onTransition(tr('DOWN', 'WARMUP', null, 900_000, 20_000))).toMatchObject({ sleep: true, endedAt: WALL0 + 20_000 });
});

test('uptime excludes WARMUP and gap seconds from the denominator', () => {
  const o = new OutageTracker(0, WALL0);
  ticks(o, 'UP', 1, 60);
  ticks(o, 'DOWN', 61, 70);
  ticks(o, 'WARMUP', 71, 80);
  o.onGap(80_000, 100_000);
  ticks(o, 'UP', 100, 109);
  const st = o.stats(109_000);
  expect(st.uptime15).toBeCloseTo(87.5, 5);
  expect(st.uptime60).toBeCloseTo(87.5, 5);
  const empty = new OutageTracker(0, WALL0);
  ticks(empty, 'WARMUP', 1, 3);
  expect(empty.stats(3_000).uptime15).toBeNull();
  // uptime60 sees the full hour while uptime15 only the last 15 minutes
  const long = new OutageTracker(0, WALL0);
  ticks(long, 'DOWN', 1, 100);
  ticks(long, 'UP', 101, 3600);
  expect(long.stats(3_600_000).uptime15).toBe(100);
  expect(long.stats(3_600_000).uptime60).toBeCloseTo((1 - 100 / 3600) * 100, 5);
});

test('timeline: worst state per cell, GAP for gap-only and pre-session cells, backdated rewrite', () => {
  const o = new OutageTracker(0, WALL0);
  for (let t = 1; t <= 50; t++) {
    const st: State = t === 15 ? 'DEGRADED' : t === 25 ? 'DOWN' : t > 30 && t <= 40 ? 'PORTAL' : t > 40 ? 'WARMUP' : 'UP';
    o.tick(st, t * 1000);
  }
  o.onGap(50_000, 60_000);
  expect(o.timeline(60_000, 6, 10_000)).toEqual(['UP', 'DEGRADED', 'DOWN', 'PORTAL', 'WARMUP', 'GAP']);
  expect(o.timeline(60_000, 8, 10_000)).toEqual(['GAP', 'GAP', 'UP', 'DEGRADED', 'DOWN', 'PORTAL', 'WARMUP', 'GAP']);
  expect(o.timeline(60_000, 4, 15_000)).toEqual(['DEGRADED', 'DOWN', 'PORTAL', 'WARMUP']);

  const b = new OutageTracker(0, WALL0);
  ticks(b, 'UP', 1, 13);
  b.onTransition(tr('UP', 'DOWN', 'uplink', 14_000, 10_020));
  b.tick('DOWN', 14_000);
  expect(b.timeline(14_000, 7, 2_000)).toEqual(['UP', 'UP', 'UP', 'UP', 'UP', 'DOWN', 'DOWN']);
  ticks(b, 'DOWN', 15, 20);
  b.onTransition(tr('DOWN', 'UP', null, 21_000, 18_500));
  b.tick('UP', 21_000);
  // entries 11–18 are DOWN, 19–21 UP after the backdated recovery; cell (9,11] holds 10 UP + 11 DOWN → DOWN
  expect(b.timeline(21_000, 7, 2_000)).toEqual(['UP', 'DOWN', 'DOWN', 'DOWN', 'DOWN', 'DOWN', 'UP']);
  expect(b.stats(21_000).uptime15).toBeCloseTo((1 - 8 / 21) * 100, 5);
});

test('history eviction keeps the ring bounded across a long session', () => {
  const o = new OutageTracker(0, WALL0);
  for (let t = 1; t <= 8000; t++) o.tick(t % 2 ? 'UP' : 'DEGRADED', t * 1000);
  const cells = o.timeline(8_000_000, 90, 10_000);
  expect(cells).toHaveLength(90);
  expect(cells.every((c) => c === 'DEGRADED')).toBe(true);
  expect(o.stats(8_000_000).uptime60).toBe(100);
});
