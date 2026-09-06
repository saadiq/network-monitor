import { test, expect } from 'bun:test';
import { BIN, COUNTERS_TIMEOUT_MS } from '../src/config';
import type { CounterSample } from '../src/probes/types';
import type { RunFn, RunResult } from '../src/probes/runner';
import { parseNetstat, nextCounterSample, CounterPoller } from '../src/probes/counters';

const fx = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const en1 = await fx('netstat-ib-en1.txt');
const utun0 = await fx('netstat-ib-utun0.txt');
const all = await fx('netstat-ib-all.txt');
const header = await fx('netstat-ib-header-only.txt');

// ---- parseNetstat (§4.7)
test('parseNetstat: en1 11-token <Link#> row', () => {
  expect(parseNetstat(en1, 'en1')).toEqual({ ibytes: 71754066013, obytes: 29368845196 });
});
test('parseNetstat: utun0 10-token row (no Address column)', () => {
  expect(parseNetstat(utun0, 'utun0')).toEqual({ ibytes: 0, obytes: 100 });
});
test('parseNetstat: full table picks the <Link#> row of the requested iface only', () => {
  expect(parseNetstat(all, 'en1')).toEqual({ ibytes: 71754069104, obytes: 29368853721 });
  expect(parseNetstat(all, 'utun9')).toEqual({ ibytes: 93314547, obytes: 437707214 });
  expect(parseNetstat(all, 'lo0')).toEqual({ ibytes: 50865480499, obytes: 50865480499 });
});
test('parseNetstat: down interface shown as name* still matches', () => {
  expect(parseNetstat(all, 'gif0')).toEqual({ ibytes: 0, obytes: 0 });
});
test('parseNetstat: missing iface / header only / empty → null', () => {
  expect(parseNetstat(en1, 'en0')).toBeNull();
  expect(parseNetstat(header, 'en1')).toBeNull();
  expect(parseNetstat('', 'en1')).toBeNull();
});
test('parseNetstat: exact name match (en1 vs en10) and non-Link rows ignored', () => {
  expect(parseNetstat('en10  1500  <Link#5>  aa:bb  1 0 10 1 0 20 0\n', 'en1')).toBeNull();
  expect(parseNetstat('en1   1500  192.168.0  192.168.0.65  1 - 10 1 - 20 -\n', 'en1')).toBeNull();
});
test('parseNetstat: malformed short row → null', () => {
  expect(parseNetstat('en1 1500 <Link#16> aa:bb 1 0\n', 'en1')).toBeNull();
});

// ---- nextCounterSample (pure rate/delta logic)
const reading = (at: number, ibytes: number, obytes: number, iface = 'en1') => ({ iface, ibytes, obytes, at });
const s = (at: number, ibytes: number, obytes: number, iface = 'en1'): CounterSample =>
  ({ iface, ibytes, obytes, at, inKBs: null, outKBs: null });

test('nextCounterSample: first reading has no rate and no delta', () => {
  expect(nextCounterSample(null, reading(1000, 500, 100))).toEqual({ sample: s(1000, 500, 100), dIn: 0, dOut: 0 });
});
test('nextCounterSample: 1 s later → KB/s = bytes / ms, positive deltas', () => {
  const r = nextCounterSample(s(1000, 500, 100), reading(2000, 42500, 6100));
  expect(r.sample.inKBs).toBe(42);
  expect(r.sample.outKBs).toBe(6);
  expect(r.dIn).toBe(42000);
  expect(r.dOut).toBe(6000);
});
test('nextCounterSample: negative delta (counter reset) → skipped', () => {
  const r = nextCounterSample(s(1000, 500, 100), reading(2000, 400, 100));
  expect(r.sample.inKBs).toBeNull();
  expect(r.sample.outKBs).toBeNull();
  expect(r.dIn).toBe(0);
  expect(r.dOut).toBe(0);
});
test('nextCounterSample: Δt > 5 s or Δt ≤ 0 → skipped', () => {
  expect(nextCounterSample(s(1000, 0, 0), reading(6001, 100, 100)).sample.inKBs).toBeNull();
  expect(nextCounterSample(s(1000, 0, 0), reading(6000, 100, 100)).sample.inKBs).toBe(0.02);
  expect(nextCounterSample(s(1000, 0, 0), reading(1000, 100, 100)).sample.inKBs).toBeNull();
});
test('nextCounterSample: interface change → skipped', () => {
  const r = nextCounterSample(s(1000, 0, 0, 'en1'), reading(2000, 100, 100, 'utun9'));
  expect(r.sample.inKBs).toBeNull();
  expect(r.sample.iface).toBe('utun9');
});

// ---- CounterPoller with injected run() and clock
const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', ms: 1, timedOut: false });
const fail: RunResult = { ok: false, code: null, stdout: '', stderr: '', ms: 2000, timedOut: true };
const row = (iface: string, ib: number, ob: number) =>
  `Name  Mtu  Network  Address  Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n${iface} 1500 <Link#1> aa:bb 1 0 ${ib} 1 0 ${ob} 0\n`;

function harness(): { p: CounterPoller; set: (r: RunResult) => void; tick: (ms: number) => void; calls: { argv: string[]; t: number }[]; got: CounterSample[] } {
  let now = 10000;
  let res = ok(row('en1', 1000, 2000));
  const calls: { argv: string[]; t: number }[] = [];
  const got: CounterSample[] = [];
  const run: RunFn = async (argv, t) => { calls.push({ argv, t }); return res; };
  const p = new CounterPoller({ iface: 'en1', run, now: () => now });
  p.start((sample) => got.push(sample));
  p.stop(); // stop the timer chain; drive with pollOnce()
  return { p, set: (r) => { res = r; }, tick: (ms) => { now += ms; }, calls, got };
}

test('CounterPoller: rates, session totals, timeout, argv', async () => {
  const h = harness();
  const first = await h.p.pollOnce();
  expect(first).toMatchObject({ iface: 'en1', ibytes: 1000, obytes: 2000, inKBs: null, outKBs: null });
  expect(h.calls[0]?.argv).toEqual([BIN.netstat, '-ib', '-I', 'en1']);
  expect(h.calls[0]?.t).toBe(COUNTERS_TIMEOUT_MS);
  h.tick(1000);
  h.set(ok(row('en1', 43000, 8000)));
  const second = await h.p.pollOnce();
  expect(second).toMatchObject({ inKBs: 42, outKBs: 6 });
  expect(h.p.totals).toEqual({ sessionIn: 42000, sessionOut: 6000 });
  expect(h.got.length).toBe(0); // stopped poller does not emit
});

test('CounterPoller: failed netstat keeps prev so the next delta spans both seconds', async () => {
  const h = harness();
  await h.p.pollOnce();
  h.tick(1000);
  h.set(fail);
  expect(await h.p.pollOnce()).toBeNull();
  h.tick(1000);
  h.set(ok(row('en1', 3000, 2000)));
  expect((await h.p.pollOnce())?.inKBs).toBe(1);
  expect(h.p.totals.sessionIn).toBe(2000);
});

test('CounterPoller: setIface keeps totals, first sample on new iface is skipped', async () => {
  const h = harness();
  await h.p.pollOnce();
  h.tick(1000);
  h.set(ok(row('en1', 2000, 3000)));
  await h.p.pollOnce();
  expect(h.p.totals).toEqual({ sessionIn: 1000, sessionOut: 1000 });
  h.p.setIface('utun9');
  h.tick(1000);
  h.set(ok(row('utun9', 900000, 900000)));
  const s1 = await h.p.pollOnce();
  expect(s1).toMatchObject({ iface: 'utun9', inKBs: null, outKBs: null });
  expect(h.calls.at(-1)?.argv).toEqual([BIN.netstat, '-ib', '-I', 'utun9']);
  h.tick(1000);
  h.set(ok(row('utun9', 900500, 900000)));
  expect((await h.p.pollOnce())?.inKBs).toBe(0.5);
  expect(h.p.totals).toEqual({ sessionIn: 1500, sessionOut: 1000 });
  h.p.setIface(null);
  expect(await h.p.pollOnce()).toBeNull();
});

test('CounterPoller: start emits samples on the timer chain', async () => {
  const got: CounterSample[] = [];
  const run: RunFn = async () => ok(row('en1', 1, 1));
  const p = new CounterPoller({ run });
  p.start((sample, totals) => { got.push(sample); expect(totals).toEqual({ sessionIn: 0, sessionOut: 0 }); });
  await Bun.sleep(20);
  expect(got.length).toBe(0); // no iface yet
  p.setIface('en1');
  await Bun.sleep(20);
  expect(got.length).toBe(0); // next timer tick (1 s) has not fired; no immediate poll on setIface
  p.stop();
});
