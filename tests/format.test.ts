import { test, expect } from 'bun:test';
import {
  fmtDuration, fmtClock, fmtAgo, fmtBytes, fmtRate, fmtRateShort, fmtMbps, fmtMs, fmtMsShort,
  fmtSecs, fmtPct, fmtTime, fmtHm, visibleWidth, padEnd, padStart, truncate, fit, stripAnsi,
} from '../src/core/format';

test('fmtDuration', () => {
  expect(fmtDuration(9)).toBe('9s');
  expect(fmtDuration(0)).toBe('0s');
  expect(fmtDuration(252)).toBe('4m12s');
  expect(fmtDuration(64)).toBe('1m04s');
  expect(fmtDuration(3720)).toBe('1h02m');
  expect(fmtDuration(59.6)).toBe('1m00s');
  expect(fmtDuration(-5)).toBe('0s');
});

test('fmtClock', () => {
  expect(fmtClock(42)).toBe('0:42');
  expect(fmtClock(65)).toBe('1:05');
  expect(fmtClock(3727)).toBe('1:02:07');
  expect(fmtClock(0.9)).toBe('0:00');
});

test('fmtAgo', () => {
  expect(fmtAgo(28)).toBe('28s ago');
  expect(fmtAgo(12 * 60 + 30)).toBe('12m ago');
  expect(fmtAgo(3720)).toBe('1h02m ago');
});

test('fmtBytes / fmtRate (SI units)', () => {
  expect(fmtBytes(120)).toBe('120 B');
  expect(fmtBytes(42_000)).toBe('42 KB');
  expect(fmtBytes(400_000)).toBe('0.4 MB');
  expect(fmtBytes(38_200_000)).toBe('38.2 MB');
  expect(fmtBytes(4_100_000)).toBe('4.1 MB');
  expect(fmtBytes(1_200_000_000)).toBe('1.20 GB');
  expect(fmtRate(42_000)).toBe('42 KB/s');
  expect(fmtRate(6_400)).toBe('6 KB/s');
  expect(fmtRate(0)).toBe('0 KB/s');
  expect(fmtRate(2_800_000)).toBe('2.8 MB/s');
  expect(fmtRateShort(42_000)).toBe('42K');
  expect(fmtRateShort(2_800_000)).toBe('2.8M');
  expect(fmtMbps(1.1)).toBe('1.1 Mbps');
  expect(fmtMbps(22.4)).toBe('22 Mbps');
});

test('fmtMs / fmtMsShort / fmtSecs / fmtPct', () => {
  expect(fmtMs(48.4)).toBe('48');
  expect(fmtMs(7)).toBe('7');
  expect(fmtMsShort(71)).toBe('71ms');
  expect(fmtMsShort(1800)).toBe('1.8s');
  expect(fmtMsShort(12_400)).toBe('12s');
  expect(fmtSecs(310)).toBe('0.31 s');
  expect(fmtSecs(1800)).toBe('1.8 s');
  expect(fmtSecs(1800, false)).toBe('1.8s');
  expect(fmtSecs(12_400)).toBe('12 s');
  expect(fmtPct(2.4)).toBe('2%');
  expect(fmtPct(17.6)).toBe('18%');
});

test('fmtTime / fmtHm use local time', () => {
  const t = new Date(2026, 8, 6, 14, 32, 7).getTime();
  expect(fmtTime(t)).toBe('14:32:07');
  expect(fmtHm(t)).toBe('14:32');
  expect(fmtHm(new Date(2026, 0, 1, 9, 5, 0).getTime())).toBe('09:05');
});

test('visibleWidth ignores escapes and counts block glyphs as 1', () => {
  expect(visibleWidth('abc')).toBe(3);
  expect(visibleWidth('█▓▒░·✔✘–▲▼→●')).toBe(12);
  expect(visibleWidth('▁▂▃▄▅▆▇█')).toBe(8);
  expect(visibleWidth('\x1b[32m✔\x1b[39m OK')).toBe(4);
  expect(visibleWidth('\x1b[7m\x1b[1mUP\x1b[0m')).toBe(2);
  expect(visibleWidth('日本')).toBe(4);
  expect(visibleWidth('')).toBe(0);
  expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red');
});

test('padEnd / padStart pad to visible width and never truncate', () => {
  expect(padEnd('ab', 5)).toBe('ab   ');
  expect(padEnd('abcdef', 3)).toBe('abcdef');
  expect(padEnd('\x1b[32m✔\x1b[39m', 3)).toBe('\x1b[32m✔\x1b[39m  ');
  expect(padStart('7', 4)).toBe('   7');
  expect(padStart('12345', 3)).toBe('12345');
});

test('truncate keeps escapes, cuts at width, resets if cut mid-style', () => {
  expect(truncate('hello', 10)).toBe('hello');
  expect(truncate('hello world', 5)).toBe('hello');
  expect(truncate('hello', 0)).toBe('');
  expect(truncate('\x1b[31mhello\x1b[39m world', 3)).toBe('\x1b[31mhel\x1b[0m');
  expect(truncate('\x1b[31mhi\x1b[39m', 5)).toBe('\x1b[31mhi\x1b[39m');
  expect(truncate('a日b', 2)).toBe('a');
  expect(truncate('a日b', 3)).toBe('a日');
  expect(visibleWidth(truncate('█'.repeat(100), 90))).toBe(90);
});

test('fit yields exactly w visible cells', () => {
  expect(fit('abc', 5)).toBe('abc  ');
  expect(fit('abcdefgh', 5)).toBe('abcde');
  expect(visibleWidth(fit('\x1b[32m✔ OK\x1b[39m and more', 6))).toBe(6);
});
