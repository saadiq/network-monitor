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

test('records are keyed by (gen, seq): dup replies and late timeouts do not create or change records', () => {
  const w = mk();
  reply(w, 0, 40);
  reply(w, 1, 50);
  reply(w, 2, 60);
  expect(states(w)).toEqual(['1:0=RECEIVED', '1:1=RECEIVED', '1:2=RECEIVED']);
  expect(w.samples().map((s) => s.rttMs)).toEqual([40, 50, 60]);
  expect(w.samples().map((s) => s.at)).toEqual([sendT(0), sendT(1), sendT(2)]);
  reply(w, 1, 55, 1, true); // DUP! → ignored
  timeout(w, 1); // timeout after RECEIVED → ignored
  expect(w.samples().length).toBe(3);
  expect(w.samples()[1]?.state).toBe('RECEIVED');
  expect(w.samples()[1]?.rttMs).toBe(50);
  expect(w.samples().every((s) => !s.synthesized && !s.loaded)).toBe(true);
});

test('a reply after a LOST record flips it to LATE and keeps the rtt', () => {
  const w = mk();
  timeout(w, 0);
  expect(states(w)).toEqual(['1:0=LOST']);
  reply(w, 0, 1500); // arrives at sendT(0) + 1500, after the timeout line
  expect(states(w)).toEqual(['1:0=LATE']);
  expect(w.samples()[0]?.rttMs).toBe(1500);
  w.tick(sendT(0) + 1600, false);
  const st = w.stats(60_000, false);
  expect(st.late).toBe(1);
  expect(st.received).toBe(0);
  expect(st.lost).toBe(0);
  expect(st.p50).toBe(1500);
});

test('a seq with no line 2 s after its send time is synthesized LOST; a later reply makes it LATE', () => {
  const w = mk();
  reply(w, 0);
  reply(w, 1);
  w.tick(sendT(2) + 1999, false);
  expect(states(w)).toEqual(['1:0=RECEIVED', '1:1=RECEIVED']);
  w.tick(sendT(2) + 2001, false);
  expect(states(w)).toEqual(['1:0=RECEIVED', '1:1=RECEIVED', '1:2=LOST']);
  const lost = w.samples()[2];
  expect(lost?.synthesized).toBe(true);
  expect(lost?.at).toBe(sendT(2));
  expect(lost?.rttMs).toBeNull();
  reply(w, 2, 2500);
  expect(w.samples()[2]?.state).toBe('LATE');
  expect(w.samples()[2]?.rttMs).toBe(2500);
  expect(w.samples()[2]?.synthesized).toBe(false);
});

test('synthesis extrapolates past maxSeqSeen from the send cadence', () => {
  const w = mk();
  reply(w, 0);
  // no lines for seqs 1..4; at sendT(5)+100 seqs 1,2,3 are past their 2 s deadline, 4 is not
  w.tick(sendT(5) + 100, false);
  expect(states(w)).toEqual(['1:0=RECEIVED', '1:1=LOST', '1:2=LOST', '1:3=LOST']);
  // a real timeout line for seq 1 afterwards changes nothing
  w.onEvent({ kind: 'timeout', seq: 1 }, sendT(5) + 200, 1);
  expect(w.samples().length).toBe(4);
  expect(w.samples()[1]?.state).toBe('LOST');
});

test('while the stream is stalled, synthesized samples are UNMEASURED and never count as loss', () => {
  const w = mk();
  reply(w, 0);
  reply(w, 1);
  w.tick(sendT(2) + 2001, true);
  expect(states(w)).toEqual(['1:0=RECEIVED', '1:1=RECEIVED', '1:2=UNMEASURED']);
  const st = w.stats(60_000, false);
  expect(st.unmeasured).toBe(1);
  expect(st.lost).toBe(0);
  expect(st.settled).toBe(2);
  expect(st.loss).toBeNull(); // < 3 settled
  expect(w.settled(0).map((s) => s.seq)).toEqual([0, 1]);
  // a UNMEASURED record later backed by a real line becomes settled
  w.onEvent({ kind: 'timeout', seq: 2 }, sendT(3) + 2500, 1);
  expect(w.samples()[2]?.state).toBe('LOST');
});

test('a stall retroactively converts LOSTs synthesized after the last real line into UNMEASURED', () => {
  const w = mk();
  for (let s = 0; s <= 4; s++) reply(w, s);
  // process hangs after seq 4's reply (last line at sendT(4)+30)
  w.tick(sendT(5) + 2001, false); // not yet stalled → seq 5 LOST
  expect(w.samples()[5]?.state).toBe('LOST');
  w.tick(sendT(5) + 3100, true); // stalled → seq 5 was never verified by a timeout line
  expect(w.samples()[5]?.state).toBe('UNMEASURED');
  w.tick(sendT(6) + 2001, true);
  expect(w.samples()[6]?.state).toBe('UNMEASURED');
  expect(w.linkState(sendT(6) + 2001)).toBe('up');
});

test('a stall does not erase a real loss that was followed by replies', () => {
  const w = mk();
  reply(w, 0);
  reply(w, 1);
  // seq 2 lost silently (macOS cumulative rule), replies for 3 and 4 follow
  reply(w, 3);
  reply(w, 4);
  w.tick(sendT(4) + 100, false); // seq 2 past deadline → LOST
  expect(w.samples().find((s) => s.seq === 2)?.state).toBe('LOST');
  w.tick(sendT(4) + 3100, true); // stall after seq 4
  expect(w.samples().find((s) => s.seq === 2)?.state).toBe('LOST');
});

test('generation reset: old pending seqs become UNMEASURED, seq restarts at 0, old-gen lines are dropped', () => {
  const w = mk(1);
  reply(w, 0);
  reply(w, 1);
  reply(w, 2);
  // seqs 3 and 4 sent, no line yet; restart at sendT(4)+500 (header of gen 2)
  const T1 = sendT(4) + 500;
  w.onEvent({ kind: 'ignore' }, T1, 2);
  expect(states(w)).toEqual([
    '1:0=RECEIVED', '1:1=RECEIVED', '1:2=RECEIVED', '1:3=UNMEASURED', '1:4=UNMEASURED',
  ]);
  expect(w.generation).toBe(2);
  // stale line from the killed process is ignored
  w.onEvent({ kind: 'reply', seq: 5, rttMs: 30, dup: false }, T1 + 100, 1);
  expect(w.samples().length).toBe(5);
  // new generation seq 0 keyed separately from gen 1 seq 0
  w.onEvent({ kind: 'reply', seq: 0, rttMs: 30, dup: false }, sendT(0, T1) + 30, 2);
  expect(states(w).at(-1)).toBe('2:0=RECEIVED');
  expect(w.samples().at(-1)?.at).toBe(sendT(0, T1));
  expect(w.samples().filter((s) => s.seq === 0).length).toBe(2);
  w.tick(sendT(1, T1) + 2001, false);
  expect(states(w).at(-1)).toBe('2:1=LOST');
  const st = w.stats(60_000, false, sendT(1, T1) + 2001);
  expect(st.unmeasured).toBe(2);
  expect(st.received).toBe(4);
  expect(st.lost).toBe(1);
});

test('link hysteresis: 3 consecutive LOST → down (downSince = first LOST), 2 RECEIVED/LATE → up', () => {
  const w = mk();
  expect(w.linkState(T0)).toBe('unknown');
  reply(w, 0);
  expect(w.linkState(sendT(0) + 100)).toBe('unknown'); // fewer than 2 settled
  reply(w, 1);
  expect(w.linkState(sendT(1) + 100)).toBe('up');
  timeout(w, 2);
  timeout(w, 3);
  expect(w.linkState(sendT(4) + 100)).toBe('up');
  expect(w.downSince).toBeNull();
  timeout(w, 4);
  expect(w.linkState(sendT(5) + 100)).toBe('down');
  expect(w.downSince).toBe(sendT(2));
  reply(w, 5);
  expect(w.linkState(sendT(5) + 100)).toBe('down'); // one received is not enough
  reply(w, 6, 1200); // LATE-range rtt still counts as received
  expect(w.linkState(sendT(6) + 1300)).toBe('up');
  expect(w.downSince).toBeNull();
  expect(w.upSince).toBe(sendT(5));
});

test('one LOST then one RECEIVED with only 2 settled stays unknown; 2 lost + 1 received keeps previous', () => {
  const w = mk();
  timeout(w, 0);
  reply(w, 1);
  expect(w.linkState(sendT(2))).toBe('unknown');
  reply(w, 2);
  expect(w.linkState(sendT(3))).toBe('up');
  timeout(w, 3);
  timeout(w, 4);
  reply(w, 5);
  timeout(w, 6);
  timeout(w, 7);
  expect(w.linkState(sendT(8))).toBe('up');
});

test('a LATE flip retroactively repairs a lost run (link recomputed from the ring)', () => {
  const w = mk();
  reply(w, 0);
  reply(w, 1);
  timeout(w, 2);
  timeout(w, 3);
  timeout(w, 4);
  expect(w.linkState(sendT(5) + 100)).toBe('down');
  reply(w, 3, 2100); // late reply for seq 3 breaks the run
  expect(w.samples()[3]?.state).toBe('LATE');
  expect(w.linkState(sendT(5) + 200)).toBe('up');
  expect(w.downSince).toBeNull();
});

test('a sendto error flips the link down immediately for 3 s without creating a sample', () => {
  const w = mk();
  reply(w, 0);
  reply(w, 1);
  expect(w.linkState(sendT(1) + 100)).toBe('up');
  const errAt = sendT(2);
  w.onEvent({ kind: 'error', reason: 'No route to host' }, errAt, 1);
  expect(w.samples().length).toBe(2);
  expect(w.localErrorAt).toBe(errAt);
  expect(w.linkState(errAt + 100)).toBe('down');
  expect(w.downSince).toBe(errAt);
  expect(w.linkState(errAt + 3000)).toBe('down');
  expect(w.linkState(errAt + 3001)).toBe('up'); // no LOST records yet → samples decide again
  // the timeout line for that seq then creates the LOST record (no double count)
  timeout(w, 2);
  expect(w.samples().length).toBe(3);
  expect(w.samples()[2]?.state).toBe('LOST');
});

test('silence within the process own nmissedmax is real loss, not "unmeasured" (§4.2)', () => {
  const w = mk();
  for (let s = 0; s <= 9; s++) reply(w, s);
  // seqs 10–15 time out (cumulative deficit climbs to 6) and are answered late: macOS ping
  // raises nmissedmax to 6, so it prints nothing for the next 6 missing seqs.
  for (let s = 10; s <= 15; s++) timeout(w, s);
  for (let s = 10; s <= 15; s++) w.onEvent({ kind: 'reply', seq: s, rttMs: 6000, dup: false }, sendT(s) + 6000, 1);
  for (let s = 16; s <= 19; s++) reply(w, s);
  // real outage from seq 20: no lines at all, so the stream reads as stalled
  w.tick(sendT(23) + 100, true);
  expect(w.samples().filter((s) => s.state === 'LOST').map((s) => s.seq)).toEqual([20, 21]);
  w.tick(sendT(24) + 100, true);
  expect(w.linkState(sendT(24) + 100)).toBe('down');
  expect(w.downSince).toBe(sendT(20));
});

test('beyond the expected silent run a stalled stream is unmeasured again', () => {
  const w = mk();
  for (let s = 0; s <= 4; s++) reply(w, s);
  timeout(w, 5); // one printed timeout → ping reports every further missing seq immediately
  w.tick(sendT(8) + 100, true); // seq 6 missing with no line at all → not explained by ping
  expect(w.samples().filter((s) => s.seq >= 6).map((s) => s.state)).toEqual(['UNMEASURED']);
});

test('onGap: samples from before a sleep no longer decide the link state (§6.3)', () => {
  const w = mk();
  for (let s = 0; s <= 4; s++) reply(w, s);
  expect(w.linkState(sendT(4) + 100)).toBe('up');
  const wake = sendT(4) + 200_000;
  w.onGap(wake);
  expect(w.linkState(wake)).toBe('unknown');
  expect(w.downSince).toBeNull();
  expect(w.stats(600_000, false, wake).received).toBe(5); // history is kept for the metrics
});
