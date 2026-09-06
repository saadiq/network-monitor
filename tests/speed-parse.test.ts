import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildSpeedArgs, parseSpeedOut, runSpeedTest, canRun } from '../src/probes/speed';
import { fakeResult, type RunFn } from '../src/probes/run-types';
import { BIN, SPEED_PROCESS_TIMEOUT_MS, SPEED_URL } from '../src/config';

const ok = readFileSync(`${import.meta.dir}/fixtures/speed-ok.txt`, 'utf8'); // 200|250000|0.143976|1736400|0.107240

test('buildSpeedArgs matches §4.9 exactly', () => {
  expect(buildSpeedArgs()).toEqual([
    BIN.curl, '-4', '-s', '-m', '20', '-o', '/dev/null',
    '-w', '%{http_code}|%{size_download}|%{time_total}|%{speed_download}|%{time_starttransfer}',
    SPEED_URL,
  ]);
  expect(SPEED_URL).toBe('https://speed.cloudflare.com/__down?bytes=250000');
});

test('parseSpeedOut ok: downMbps measures the transfer phase, not DNS+connect+TTFB', () => {
  const r = parseSpeedOut(ok, 0); // 250000 B, total 0.143976 s, TTFB 0.107240 s
  expect(r.ok).toBe(true);
  // 250000 / (0.143976 − 0.107240) × 8 / 1e6; curl's speed_download would say 13.89 Mbps because
  // it divides by the whole wall time, setup included — a 4× understatement on a short burst.
  expect(r.downMbps).toBeCloseTo(54.4425, 3);
  expect(r.bytes).toBe(250000);
  expect(r.ms).toBe(144); // ms stays the full wall time
  expect(r.code).toBe(200);
  expect(r.why).toBeNull();
  const boundary = parseSpeedOut('200|200000|1.0|1600000|0.2', 0); // boundary ≥ 200000
  expect(boundary.ok).toBe(true);
  expect(boundary.downMbps).toBeCloseTo(2.0, 6); // 200000 / 0.8 s
});

test('parseSpeedOut falls back to speed_download when the transfer phase is unusable', () => {
  // no time_starttransfer (0 = never reached, or an old field set)
  expect(parseSpeedOut('200|250000|0.143976|1736400|0', 0).downMbps).toBeCloseTo(13.8912, 4);
  expect(parseSpeedOut('200|250000|0.143976|1736400', 0).downMbps).toBeCloseTo(13.8912, 4);
  // transfer phase too short to divide by (≤ 10 ms): the quotient would be noise
  expect(parseSpeedOut('200|250000|0.110000|1736400|0.105000', 0).downMbps).toBeCloseTo(13.8912, 4);
  // pathological ordering (starttransfer after total) also falls back
  expect(parseSpeedOut('200|250000|0.10|1736400|0.20', 0).downMbps).toBeCloseTo(13.8912, 4);
});

test('parseSpeedOut partial download keeps the bytes actually transferred', () => {
  const r = parseSpeedOut('200|120000|20.001|6000|0.5', 0);
  expect(r.ok).toBe(false);
  expect(r.downMbps).toBeNull();
  expect(r.bytes).toBe(120000);
  expect(r.code).toBe(200);
  expect(r.why).toBe('partial 120 KB');
});

test('parseSpeedOut non-200', () => {
  const r = parseSpeedOut('503|0|0.200000|0|0.100000', 0);
  expect(r.ok).toBe(false);
  expect(r.bytes).toBe(0);
  expect(r.code).toBe(503);
  expect(r.why).toBe('http 503');
});

test('parseSpeedOut timeout (curl exit 28) and no output', () => {
  const t = parseSpeedOut('000|83000|20.002|4150|0.9', 28);
  expect(t.ok).toBe(false);
  expect(t.bytes).toBe(83000);
  expect(t.code).toBeNull();
  expect(t.why).toBe('timeout');
  const e = parseSpeedOut('', null);
  expect(e).toEqual({ ok: false, downMbps: null, bytes: 0, ms: null, code: null, why: 'no output' });
  expect(parseSpeedOut('000|0|0.05|0|0', 7).why).toBe('curl exit 7');
});

test('runSpeedTest uses the §4.9 argv and process timeout', async () => {
  let seen: { argv: string[]; timeoutMs: number } | null = null;
  const run: RunFn = async (argv, timeoutMs) => { seen = { argv, timeoutMs }; return fakeResult(ok); };
  const r = await runSpeedTest(run);
  expect(r.ok).toBe(true);
  expect(seen!.argv).toEqual(buildSpeedArgs());
  expect(seen!.timeoutMs).toBe(SPEED_PROCESS_TIMEOUT_MS);
  const killed: RunFn = async () => fakeResult('', null, { timedOut: true });
  expect((await runSpeedTest(killed)).why).toBe('timeout');
  const missing: RunFn = async () => fakeResult('', null, { err: 'ENOENT' });
  expect((await runSpeedTest(missing)).why).toBe('curl missing');
});

test('canRun refuses while not UP/DEGRADED or within 30 s of the last run', () => {
  expect(canRun(100000, null, 'UP')).toEqual({ ok: true });
  expect(canRun(100000, null, 'DEGRADED')).toEqual({ ok: true });
  expect(canRun(100000, 70000, 'UP')).toEqual({ ok: true }); // exactly 30 s
  expect(canRun(100000, 90000, 'UP')).toEqual({ ok: false, why: 'wait 20s between tests' });
  expect(canRun(100000, 71000, 'UP').why).toBe('wait 1s between tests');
  expect(canRun(100000, 99999, 'UP').why).toBe('wait 30s between tests');
  for (const s of ['DOWN', 'PORTAL', 'NO_LINK'] as const) {
    expect(canRun(100000, null, s)).toEqual({ ok: false, why: 'no point testing while down' });
  }
  // nothing is down yet during WARMUP — say what we are actually waiting for
  expect(canRun(100000, null, 'WARMUP')).toEqual({ ok: false, why: 'wait for the first verdict' });
});
