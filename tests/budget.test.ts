import { test, expect } from 'bun:test';
import { Budget, BASELINE_BYTES_PER_HOUR, probeCost } from '../src/model/budget';

test('per-kind costs from config (§4.10)', () => {
  expect(probeCost('ping')).toBe(88);
  expect(probeCost('dns')).toBe(300);
  expect(probeCost('captive')).toBe(1000);
  expect(probeCost('https')).toBe(5000);
  expect(probeCost('speed', 250000)).toBe(252000);
  expect(probeCost('speed')).toBe(2000);
  expect(probeCost('captive', 1234)).toBe(1234);
});

test('baseline ≈ 1.2 MB/h', () => {
  expect(BASELINE_BYTES_PER_HOUR).toBe(633600 + 72000 + 360000 + 100000);
  expect(BASELINE_BYTES_PER_HOUR / 1e6).toBeCloseTo(1.17, 2);
});

test('accumulates total, speed bytes and the hourly estimate', () => {
  const b = new Budget();
  expect(b.total).toBe(0);
  expect(b.perHourEstimate).toBe(BASELINE_BYTES_PER_HOUR);
  b.add('ping'); b.add('ping'); b.add('dns'); b.add('captive'); b.add('https');
  expect(b.total).toBe(88 * 2 + 300 + 1000 + 5000);
  b.add('speed', 250000);
  expect(b.speedBytes).toBe(252000);
  expect(b.total).toBe(88 * 2 + 300 + 1000 + 5000 + 252000);
  // a manual speed test is a one-off: it shows up in the session total, never in the steady rate
  expect(b.perHourEstimate).toBe(BASELINE_BYTES_PER_HOUR);
  expect(b.counts.ping).toBe(2);
  expect(b.counts.speed).toBe(1);
});

test('observed rate needs a minute of data', () => {
  const b = new Budget();
  for (let i = 0; i < 120; i++) b.add('ping');
  expect(b.observedPerHour(30)).toBeNull();
  expect(b.observedPerHour(60)).toBe(120 * 88 * 60);
});
