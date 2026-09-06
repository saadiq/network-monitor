// Scripted ping/http/dns feed for the Store integration tests: one second at a time, no I/O,
// clocks injected. Shared by tests/store.test.ts and tests/store-sleep.test.ts.
import { Store, type StreamHealth } from '../../src/model/store';
import type { DnsPair, HttpResult } from '../../src/probes/types';

export const BASE = 100_000; // monotonic ms at start
export const WALL = new Date(2026, 8, 6, 14, 0, 0).getTime();
export const EPOCH = BASE + 20; // §4.2 sendEpoch = spawn + 20 ms
export const LIVE: StreamHealth = { inetStalled: false, gwStalled: false, gwActive: true };

export const httpOk = (startedAt: number): HttpResult => ({
  kind: 'ok', detector: 'apple', url: 'http://captive.apple.com/hotspot-detect.html', code: 200, exitCode: 0,
  startedAt, ms: 310, connectMs: 40, redirectUrl: null,
});
export const httpFail = (startedAt: number): HttpResult =>
  ({ ...httpOk(startedAt), kind: 'fail', code: null, exitCode: 7, connectMs: null });
export const dnsOk = (at: number): DnsPair => ({
  name: 'www.apple.com', at,
  sys: { ok: true, ms: 380, server: '100.100.100.100', status: 'NOERROR', err: null },
  direct: { ok: true, ms: 31, server: '1.1.1.1', status: 'NOERROR', err: null },
});

/** Drive the store one second at a time; `feed(i)` runs before tick i (1-based). */
export class Sim {
  readonly store = new Store({ target: '1.1.1.1', now: BASE, wall: WALL });
  tickNo = 0;
  readonly log: string[] = [];

  constructor() {
    this.store.onPingEvent('inet', { kind: 'ignore' }, BASE, 1); // spawn markers seed the epoch
    this.store.onPingEvent('gw', { kind: 'ignore' }, BASE, 1);
  }

  reply(stream: 'gw' | 'inet', seq: number, rtt: number): void {
    this.store.onPingEvent(stream, { kind: 'reply', seq, rttMs: rtt, dup: false }, EPOCH + seq * 1000 + rtt, 1);
  }

  timeout(stream: 'gw' | 'inet', seq: number): void {
    this.store.onPingEvent(stream, { kind: 'timeout', seq }, EPOCH + (seq + 1) * 1000, 1);
  }

  mono = 0; // monotonic ms since BASE
  wallMs = 0; // wall ms since WALL

  /** Tick i: the monotonic clock advances `mono` ms, the wall clock `wallMs` (a sleep only the wall). */
  tick(gapMs = 1000, mono = 1000, wallMs = mono) {
    this.tickNo++;
    this.mono += mono;
    this.wallMs += wallMs;
    const out = this.store.tick(BASE + this.mono, WALL + this.wallMs, gapMs, LIVE);
    for (const t of out.transitions) this.log.push(`${this.tickNo}:${t.from}>${t.to}/${t.cause ?? '-'}`);
    return out;
  }
}

/** Healthy second i: replies for seq i−1 on both streams before tick i. */
export function healthy(sim: Sim, i: number): void {
  sim.reply('inet', i - 1, 45);
  sim.reply('gw', i - 1, 6);
}

/** A healthy second with the slower probes refreshed every 10 s, then the tick. */
export function healthyTick(sim: Sim, i: number): void {
  healthy(sim, i);
  if (i % 10 === 0) {
    sim.store.onHttp(httpOk(BASE + i * 1000 - 500));
    sim.store.onDns(dnsOk(BASE + i * 1000 - 500));
  }
  sim.tick();
}

/** UP → 9 s uplink drop → UP again; ends after tick 24 with one closed outage. */
export function upDropUp(sim: Sim): void {
  const s = sim.store;
  healthy(sim, 1);
  s.onHttp(httpOk(BASE + 500));
  s.onDns(dnsOk(BASE + 500));
  sim.tick();
  for (let i = 2; i <= 9; i++) healthyTick(sim, i);
  for (let i = 10; i <= 18; i++) {
    sim.reply('gw', i - 1, 6);
    if (i - 2 >= 9) sim.timeout('inet', i - 2); // ping prints the timeout at the next send
    if (i === 14) s.onHttp(httpFail(BASE + 13_000));
    sim.tick();
  }
  for (let i = 19; i <= 24; i++) healthyTick(sim, i);
}
