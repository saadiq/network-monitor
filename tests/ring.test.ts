import { test, expect } from 'bun:test';
import { RingBuffer } from '../src/core/ring';

type Item = { at: number; v: string };
const mk = (cap: number) => new RingBuffer<Item>(cap, (i) => i.at);
const fill = (r: RingBuffer<Item>, ats: number[]) => {
  for (const at of ats) r.push({ at, v: `v${at}` });
};

test('push / size / toArray keep insertion order and overwrite oldest when full', () => {
  const r = mk(3);
  expect(r.size).toBe(0);
  fill(r, [1, 2]);
  expect(r.size).toBe(2);
  expect(r.toArray().map((i) => i.at)).toEqual([1, 2]);
  fill(r, [3, 4, 5]);
  expect(r.size).toBe(3);
  expect(r.toArray().map((i) => i.at)).toEqual([3, 4, 5]);
  expect(r.oldest()?.at).toBe(3);
  expect(r.newest()?.at).toBe(5);
  expect(r.get(1)?.at).toBe(4);
  expect(r.get(3)).toBeUndefined();
  expect(r.get(-1)).toBeUndefined();
});

test('last(n) returns the newest n oldest→newest, clamped to size', () => {
  const r = mk(5);
  fill(r, [10, 20, 30, 40, 50, 60]);
  expect(r.last(2).map((i) => i.at)).toEqual([50, 60]);
  expect(r.last(10).map((i) => i.at)).toEqual([20, 30, 40, 50, 60]);
  expect(r.last(0)).toEqual([]);
  expect(r.last(-3)).toEqual([]);
});

test('since(ms) returns items with at ≥ ms (inclusive), scanning all items', () => {
  const r = mk(10);
  fill(r, [100, 200, 150, 300]);
  expect(r.since(150).map((i) => i.at)).toEqual([200, 150, 300]);
  expect(r.since(301)).toEqual([]);
  expect(r.since(0).length).toBe(4);
});

test('evictBefore pops from the oldest end and reports the count', () => {
  const r = mk(4);
  fill(r, [1, 2, 3, 4, 5, 6]); // holds 3..6
  expect(r.evictBefore(5)).toBe(2);
  expect(r.toArray().map((i) => i.at)).toEqual([5, 6]);
  expect(r.evictBefore(5)).toBe(0);
  fill(r, [7, 8, 9]); // wraps: 5,6,7,8 → 6,7,8,9
  expect(r.toArray().map((i) => i.at)).toEqual([6, 7, 8, 9]);
  expect(r.evictBefore(100)).toBe(4);
  expect(r.size).toBe(0);
  expect(r.newest()).toBeUndefined();
  fill(r, [11]);
  expect(r.toArray().map((i) => i.at)).toEqual([11]);
});

test('clear empties the ring and it keeps working afterwards', () => {
  const r = mk(2);
  fill(r, [1, 2, 3]);
  r.clear();
  expect(r.size).toBe(0);
  fill(r, [4]);
  expect(r.toArray().map((i) => i.at)).toEqual([4]);
});

test('rejects a non-positive capacity', () => {
  expect(() => mk(0)).toThrow(RangeError);
  expect(() => mk(1.5)).toThrow(RangeError);
});
