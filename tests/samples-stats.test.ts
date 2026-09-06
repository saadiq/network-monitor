import { test, expect } from 'bun:test';
import { SampleWindow } from '../src/model/samples';
import type { PingEvent } from '../src/probes/types';

// Timing model (§4.2): spawn at T0 (header line), sendEpoch = T0 + 20, sendTime(seq) = epoch + seq × 1000.
const T0 = 100_000;
const sendT = (seq: number, t0 = T0): number => t0 + 20 + seq * 1000;

function mk(gen = 1, t0 = T0): SampleWindow {
  const w = new SampleWindow();
  w.onEvent({ kind: 'ignore' }, t0, gen); // header line at spawn time
  return w;
}
const reply = (w: SampleWindow, seq: number, rtt = 30, gen = 1, dup = false): void =>
  w.onEvent({ kind: 'reply', seq, rttMs: rtt, dup }, sendT(seq) + rtt, gen);
// macOS prints `Request timeout for icmp_seq N` at the next send
const timeout = (w: SampleWindow, seq: number, gen = 1): void =>
  w.onEvent({ kind: 'timeout', seq }, sendT(seq + 1), gen);
const states = (w: SampleWindow): string[] => w.samples().map((s) => `${s.gen}:${s.seq}=${s.state}`);

test('stats: percentiles over RECEIVED+LATE, loss over settled, UNMEASURED excluded everywhere', () => {
  const w = mk();
  const rtts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  rtts.forEach((r, i) => reply(w, i, r));
  timeout(w, 10);
  timeout(w, 11);
  // seq 12 sent, stream stalls → UNMEASURED
  w.tick(sendT(12) + 2001, true);
  expect(w.samples()[12]?.state).toBe('UNMEASURED');
  const now = sendT(12) + 2001;
  const st = w.stats(60_000, false, now);
  expect(st.windowMs).toBe(60_000);
  expect(st.idleOnly).toBe(false);
  expect(st.received).toBe(10);
  expect(st.late).toBe(0);
  expect(st.lost).toBe(2);
  expect(st.unmeasured).toBe(1);
  expect(st.settled).toBe(12);
  expect(st.p50).toBe(50);
  expect(st.p95).toBe(100);
  expect(st.p10).toBe(10);
  expect(st.jitter).toBe(10);
  expect(st.loss).toBeCloseTo((2 / 12) * 100, 6);
  expect(st.loss60).toBeCloseTo((2 / 12) * 100, 6);
  expect(st.loss300).toBeCloseTo((2 / 12) * 100, 6);
  // loss10: at ≥ now − 10 s = sendT(2) + 2001 → seqs 5..12 → settled 5..11 (7), lost 2
  expect(st.loss10).toBeCloseTo((2 / 7) * 100, 6);
  expect(w.stats(60_000, false, now + 5_000_000).p50).toBeNull(); // nothing in window
});

test('stats: windowMs bounds the sample set; jitter pairs skip losses; null below minimums', () => {
  const w = mk();
  reply(w, 0, 100);
  timeout(w, 1);
  reply(w, 2, 120);
  reply(w, 3, 100);
  const now = sendT(3) + 100;
  const all = w.stats(60_000, false, now);
  expect(all.jitter).toBe(20); // |120−100| + |100−120| over 3 rtts → 40/2
  const narrow = w.stats(1_500, false, now); // only seqs 2 and 3
  expect(narrow.received).toBe(2);
  expect(narrow.lost).toBe(0);
  expect(narrow.jitter).toBeNull();
  expect(narrow.loss).toBeNull();
  expect(narrow.p50).toBe(100);
  expect(narrow.p95).toBe(120);
});

test('markLoaded tags existing and future samples; idleOnly stats exclude them', () => {
  const w = mk();
  reply(w, 0, 10);
  reply(w, 1, 10);
  reply(w, 2, 500);
  w.markLoaded(sendT(2), sendT(3)); // covers seqs 2 (existing) and 3 (future)
  reply(w, 3, 600);
  reply(w, 4, 12);
  expect(w.samples().map((s) => s.loaded)).toEqual([false, false, true, true, false]);
  const now = sendT(4) + 100;
  const idle = w.stats(60_000, true, now);
  expect(idle.idleOnly).toBe(true);
  expect(idle.received).toBe(3);
  expect(idle.p95).toBe(12);
  const all = w.stats(60_000, false, now);
  expect(all.received).toBe(5);
  expect(all.p95).toBe(600);
});

test('rttHistory: last n non-UNMEASURED samples oldest→newest, null for LOST', () => {
  const w = mk();
  reply(w, 0, 11);
  timeout(w, 1);
  reply(w, 2, 13);
  w.tick(sendT(3) + 2001, true); // seq 3 UNMEASURED
  reply(w, 4, 15);
  expect(w.rttHistory(10)).toEqual([11, null, 13, 15]);
  expect(w.rttHistory(2)).toEqual([13, 15]);
});

test('blips: LOST runs of 1–2 terminated by a reply, inside the window; longer or open runs excluded', () => {
  const w = mk();
  reply(w, 0);
  timeout(w, 1); // run of 1 → blip
  reply(w, 2);
  timeout(w, 3);
  timeout(w, 4); // run of 2 → blip
  reply(w, 5);
  timeout(w, 6);
  timeout(w, 7);
  timeout(w, 8); // run of 3 → outage, not a blip
  reply(w, 9);
  reply(w, 10);
  timeout(w, 11); // open run at the end → not counted yet
  const now = sendT(12) + 100;
  expect(w.blips(60_000, now)).toBe(2);
  expect(w.blips(5_000, now)).toBe(0); // window starts after both blips (seq ≥ 7)
  reply(w, 12);
  expect(w.blips(60_000, sendT(12) + 200)).toBe(3);
});

test('sendEpoch is inferred from the first reply or timeout when no header line was seen', () => {
  const w1 = new SampleWindow();
  w1.onEvent({ kind: 'reply', seq: 3, rttMs: 40, dup: false }, 50_000, 1);
  expect(w1.samples()[0]?.at).toBe(50_000 - 40);
  const w2 = new SampleWindow();
  w2.onEvent({ kind: 'timeout', seq: 0 }, 60_000, 1);
  expect(w2.samples()[0]?.at).toBe(59_000);
});

test('sendEpoch converges by EWMA (α 0.1) toward the replies', () => {
  const w = mk(); // epoch seeded at T0 + 20; true epoch is T0 + 50
  const trueEpoch = T0 + 50;
  for (let s = 0; s < 40; s++) w.onEvent({ kind: 'reply', seq: s, rttMs: 30, dup: false }, trueEpoch + s * 1000 + 30, 1);
  const last = w.samples().at(-1);
  expect(Math.abs((last?.at ?? 0) - (trueEpoch + 39 * 1000))).toBeLessThan(2);
  // earlier records keep the send time computed when they were created
  expect(Math.abs((w.samples()[0]?.at ?? 0) - sendT(0))).toBeLessThan(5);
});

test('settled(sinceMs) is absolute time, seq-ordered, excludes UNMEASURED', () => {
  const w = mk();
  reply(w, 0);
  timeout(w, 1);
  reply(w, 2);
  w.tick(sendT(3) + 2001, true);
  reply(w, 4);
  expect(w.settled(sendT(1)).map((s) => s.seq)).toEqual([1, 2, 4]);
  expect(w.settled(sendT(4)).map((s) => s.seq)).toEqual([4]);
});

test('unknown lines are counted in errs; samples older than 900 s are evicted on tick', () => {
  const w = mk();
  w.onEvent({ kind: 'unknown', line: 'garbage' }, T0 + 5, 1);
  w.onEvent({ kind: 'unknown', line: 'more' }, T0 + 6, 1);
  expect(w.errs).toBe(2);
  reply(w, 0);
  reply(w, 1);
  expect(w.size).toBe(2);
  const now = sendT(1) + 900_000 + 1;
  w.tick(now, true);
  // the real samples are gone; the gap is back-filled with UNMEASURED only over the last 120 s
  expect(w.samples().every((s) => s.state === 'UNMEASURED')).toBe(true);
  expect(w.size).toBeGreaterThan(100);
  expect(w.size).toBeLessThanOrEqual(120);
  const un = w.stats(60_000, false, now).unmeasured;
  expect(un).toBeGreaterThanOrEqual(57);
  expect(un).toBeLessThanOrEqual(60);
});

test('a burst of ignore events with the same generation does not reset anything', () => {
  const w = mk();
  reply(w, 0);
  w.onEvent({ kind: 'ignore' }, sendT(0) + 500, 1);
  const e: PingEvent = { kind: 'ignore' };
  w.onEvent(e, sendT(0) + 600, 1);
  expect(w.samples().length).toBe(1);
  expect(w.generation).toBe(1);
});
