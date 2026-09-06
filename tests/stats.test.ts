import { test, expect } from 'bun:test';
import { percentile, median, mean, jitter, lossPct, round50, sortAsc, clamp } from '../src/core/stats';

const oneToTen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('percentile is nearest-rank', () => {
  expect(percentile(oneToTen, 50)).toBe(5);
  expect(percentile(oneToTen, 95)).toBe(10);
  expect(percentile(oneToTen, 10)).toBe(1);
  expect(percentile(oneToTen, 90)).toBe(9);
  expect(percentile([7, 9, 11], 50)).toBe(9);
  expect(percentile([7, 9, 11, 13], 50)).toBe(9);
});

test('percentile clamps rank and handles edges', () => {
  expect(percentile([], 50)).toBeNull();
  expect(percentile([42], 95)).toBe(42);
  expect(percentile(oneToTen, 0)).toBe(1);
  expect(percentile(oneToTen, 100)).toBe(10);
  expect(percentile(oneToTen, 150)).toBe(10);
});

test('median is nearest-rank p50 of an unsorted list', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([10, 20])).toBe(10);
  expect(median([22, 9, 64])).toBe(22);
  expect(median([])).toBeNull();
});

test('mean and sortAsc', () => {
  expect(mean([1, 2, 3])).toBe(2);
  expect(mean([])).toBeNull();
  expect(sortAsc([3, 1, 2])).toEqual([1, 2, 3]);
});

test('jitter is mean |delta| of consecutive samples, null below 3', () => {
  expect(jitter([10, 20])).toBeNull();
  expect(jitter([])).toBeNull();
  expect(jitter([10, 20, 10])).toBe(10);
  expect(jitter([50, 50, 50, 50])).toBe(0);
  expect(jitter([10, 30, 20, 25])).toBeCloseTo(35 / 3, 6);
});

test('lossPct counts LATE as received and needs 3 settled samples', () => {
  expect(lossPct({ received: 8, late: 1, lost: 1 })).toBe(10);
  expect(lossPct({ received: 1, late: 0, lost: 1 })).toBeNull();
  expect(lossPct({ received: 0, late: 0, lost: 3 })).toBe(100);
  expect(lossPct({ received: 60, late: 0, lost: 0 })).toBe(0);
  expect(lossPct({ received: 0, late: 0, lost: 0 })).toBeNull();
});

test('round50 and clamp', () => {
  expect(round50(612)).toBe(600);
  expect(round50(625)).toBe(650);
  expect(round50(0)).toBe(0);
  expect(round50(-10)).toBe(0);
  expect(round50(349)).toBe(350);
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-1, 0, 3)).toBe(0);
  expect(clamp(2, 0, 3)).toBe(2);
});
