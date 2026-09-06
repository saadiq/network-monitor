import { test, expect } from 'bun:test';
import { computeTrend, trendHalf, trendFromSamples, NO_TREND } from '../src/model/trend';
import type { TrendHalf } from '../src/model/trend';
import type { PingSample, SampleState } from '../src/probes/types';

const half = (p50: number | null, loss: number | null, received = 40, late = 0): TrendHalf => ({ p50, loss, received, late });

// ---- §7.3 latency ---------------------------------------------------------------

test('latency worse needs ≥ 1.25× AND ≥ +20 ms', () => {
  expect(computeTrend(half(125, 0), half(100, 0)).latency).toBe('worse');
  expect(computeTrend(half(124, 0), half(100, 0)).latency).toBe('flat'); // ratio short
  expect(computeTrend(half(55, 0), half(40, 0)).latency).toBe('flat'); // 1.375× but only +15
  expect(computeTrend(half(60, 0), half(40, 0)).latency).toBe('worse'); // 1.5× and +20
});

test('latency better needs ≤ 0.8× AND ≥ 20 ms lower', () => {
  expect(computeTrend(half(80, 0), half(100, 0)).latency).toBe('better');
  expect(computeTrend(half(81, 0), half(100, 0)).latency).toBe('flat');
  expect(computeTrend(half(40, 0), half(50, 0)).latency).toBe('flat'); // 0.8× but only −10
  expect(computeTrend(half(100, 0), half(100, 0)).latency).toBe('flat');
});

// ---- §7.3 loss ------------------------------------------------------------------

test('loss worse at +3 points, better at −3, flat between', () => {
  expect(computeTrend(half(50, 5), half(50, 2)).loss).toBe('worse');
  expect(computeTrend(half(50, 4.9), half(50, 2)).loss).toBe('flat');
  expect(computeTrend(half(50, 2), half(50, 5)).loss).toBe('better');
  expect(computeTrend(half(50, 2.1), half(50, 5)).loss).toBe('flat');
});

// ---- §7.3 phrase ----------------------------------------------------------------

test('phrase: any worse and none better → getting worse; vice versa → improving; mixed → none', () => {
  const worse = computeTrend(half(200, 0), half(100, 0));
  expect(worse.overall).toBe('worse');
  expect(worse.phrase).toBe('getting worse');
  const better = computeTrend(half(50, 0), half(100, 0));
  expect(better.overall).toBe('better');
  expect(better.phrase).toBe('improving');
  const mixed = computeTrend(half(200, 0), half(100, 5)); // latency worse, loss better
  expect(mixed.latency).toBe('worse');
  expect(mixed.loss).toBe('better');
  expect(mixed.overall).toBeNull();
  expect(mixed.phrase).toBeNull();
  const flat = computeTrend(half(100, 1), half(100, 1));
  expect(flat.overall).toBeNull();
  expect(flat.phrase).toBeNull();
});

test('values are carried in the result', () => {
  const t = computeTrend(half(125, 5), half(100, 2));
  expect(t.p50Last).toBe(125);
  expect(t.p50Prior).toBe(100);
  expect(t.lossLast).toBe(5);
  expect(t.lossPrior).toBe(2);
});

// ---- §7.3 sample requirement ----------------------------------------------------

test('fewer than 10 received samples in either half → no trend', () => {
  const t = computeTrend(half(200, 0, 9), half(100, 0, 40));
  expect(t.latency).toBeNull();
  expect(t.loss).toBeNull();
  expect(t.overall).toBeNull();
  expect(t.phrase).toBeNull();
  expect(computeTrend(half(200, 0, 40), half(100, 0, 9)).latency).toBeNull();
  expect(computeTrend(half(200, 0, 5, 5), half(100, 0, 10)).latency).toBe('worse'); // LATE counts
  expect(computeTrend(half(null, null, 0), half(null, null, 0))).toEqual(NO_TREND);
});

test('null p50 or loss with enough samples leaves that direction null', () => {
  const t = computeTrend(half(100, null), half(100, 2));
  expect(t.latency).toBe('flat');
  expect(t.loss).toBeNull();
});

// ---- trendHalf / trendFromSamples -----------------------------------------------

function s(at: number, state: SampleState, rttMs: number | null, loaded = false): PingSample {
  return { gen: 0, seq: at / 1000, state, rttMs, at, loaded, synthesized: false };
}

test('trendHalf counts RECEIVED+LATE, excludes UNMEASURED, and computes nearest-rank p50 + loss', () => {
  const samples = [
    s(0, 'RECEIVED', 10), s(1000, 'LATE', 30), s(2000, 'LOST', null), s(3000, 'UNMEASURED', null),
    s(4000, 'RECEIVED', 20),
  ];
  const h = trendHalf(samples);
  expect(h.received).toBe(2);
  expect(h.late).toBe(1);
  expect(h.p50).toBe(20);
  expect(h.loss).toBe(25);
});

test('trendHalf prefers idle samples when ≥ 10 idle received (§4.8)', () => {
  const idle = Array.from({ length: 10 }, (_, i) => s(i * 1000, 'RECEIVED', 50));
  const loaded = Array.from({ length: 10 }, (_, i) => s(20_000 + i * 1000, 'RECEIVED', 500, true));
  expect(trendHalf([...idle, ...loaded]).p50).toBe(50);
  expect(trendHalf([...idle.slice(0, 9), ...loaded]).p50).toBe(500); // < 10 idle → all samples
  expect(trendHalf([]).p50).toBeNull();
});

test('trendFromSamples splits the last 60 s from the prior 60 s by send time', () => {
  const now = 200_000;
  const samples: PingSample[] = [];
  for (let at = now - 120_000; at < now - 60_000; at += 1000) samples.push(s(at, 'RECEIVED', 100));
  for (let at = now - 60_000; at <= now; at += 1000) samples.push(s(at, 'RECEIVED', 200));
  samples.push(s(now - 130_000, 'RECEIVED', 5)); // outside both halves
  const t = trendFromSamples(samples, now);
  expect(t.p50Prior).toBe(100);
  expect(t.p50Last).toBe(200);
  expect(t.latency).toBe('worse');
  expect(t.phrase).toBe('getting worse');
});
