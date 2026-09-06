// §4.2 / §5 / §6.1 per-stream sample window keyed by (generation, seq). Pure: `now` is injected
// (tick / explicit args); no timers, no I/O. Send times are monotonic ms.
import {
  LOCAL_ERROR_WINDOW_MS, PING_EPOCH_EWMA_ALPHA, PING_INTERVAL_MS, PING_SEND_EPOCH_OFFSET_MS,
  SETTLE_DEADLINE_MS, WIN_HISTORY_MS, WIN_TREND_MS,
} from '../config';
import { RingBuffer } from '../core/ring';
import type { PingEvent, PingSample, SampleState, StreamStats } from '../probes/types';
import type { LinkState } from './types';
import { bySendTime, countBlips, foldLink, isSettled, rttHistoryOf, streamStats } from './samples-stats';
import type { LinkFold } from './samples-stats';

const RING_CAPACITY = Math.ceil(WIN_HISTORY_MS / 1000) + 300;
/** Back-fill (LOST/UNMEASURED synthesis) never reaches further back than this. */
const SYNTH_LOOKBACK_MS = WIN_TREND_MS;

export class SampleWindow {
  private readonly ring = new RingBuffer<PingSample>(RING_CAPACITY, (s) => s.at);
  private records = new Map<number, PingSample>(); // current generation, by seq
  private gen = -1;
  private epoch: number | null = null; // §4.2 sendEpoch of the current generation
  private maxSeq = -1;
  private lastLineAt = -Infinity; // last event of any kind (current generation)
  private lastNow = 0;
  private loadedSpans: Array<[number, number]> = [];
  private sortedCache: PingSample[] | null = null;
  private linkCache: { now: number; fold: LinkFold } | null = null;
  private missedMax = 0; // §4.2 mirror of ping's nmissedmax: largest deficit it has reported
  private nReceived = 0; // replies seen this generation (ping's nreceived)
  private foldSince = -Infinity; // §6.3 sleep gap: older samples no longer decide the link

  /** Session count of `unknown` lines (§5 errs). */
  errs = 0;
  /** Monotonic time of the last `sendto` error (§4.2), or null. */
  localErrorAt: number | null = null;

  get generation(): number {
    return this.gen;
  }

  get size(): number {
    return this.ring.size;
  }

  onEvent(e: PingEvent, at: number, gen: number): void {
    if (gen < this.gen) return; // line from a killed process
    if (gen > this.gen) this.beginGeneration(gen, at, e);
    this.lastLineAt = at;
    this.lastNow = Math.max(this.lastNow, at);
    this.linkCache = null;
    switch (e.kind) {
      case 'reply': this.onReply(e.seq, e.rttMs, e.dup, at); break;
      case 'timeout': this.onTimeout(e.seq); break; // §4.2: printed at the next send
      case 'error': this.localErrorAt = at; break; // no sample: the timeout line follows (§4.2)
      case 'unknown': this.errs++; break;
      default: break;
    }
  }

  /** Once per tick: evict, synthesize LOST (UNMEASURED while `stalled`), repair unverified LOSTs. */
  tick(now: number, stalled: boolean): void {
    this.lastNow = now;
    this.linkCache = null;
    const cutoff = now - WIN_HISTORY_MS;
    if (this.ring.evictBefore(cutoff) > 0) {
      this.sortedCache = null;
      for (const [seq, r] of this.records) if (r.at < cutoff) this.records.delete(seq);
    }
    this.loadedSpans = this.loadedSpans.filter(([, to]) => to >= cutoff);
    // silence real ping would also produce (§4.2 nmissedmax) is loss, not "couldn't measure"
    const unexplained = stalled && !this.silenceExpected(now);
    this.synthesize(now, unexplained);
    if (unexplained) this.unverifiedToUnmeasured();
  }

  /** §6.3: after a tick gap nothing measured before it decides the link (or explains silence). */
  onGap(now: number): void {
    this.foldSince = now;
    this.missedMax = 0;
    this.linkCache = null;
  }

  /** Settled (non-UNMEASURED) samples with send time ≥ sinceMs (absolute monotonic), seq order. */
  settled(sinceMs: number): PingSample[] {
    return this.sorted().filter((s) => isSettled(s) && s.at >= sinceMs);
  }

  /** Every sample in the ring, send-time order (copy). */
  samples(): PingSample[] {
    return [...this.sorted()];
  }

  /** §6.1 hysteresis; `now` defaults to the last tick. */
  linkState(now: number = this.lastNow): LinkState {
    return this.link(now).link;
  }

  /** Send time of the first LOST of the run that produced `down` (or the sendto error time). */
  get downSince(): number | null {
    return this.link(this.lastNow).downSince;
  }

  /** Send time of the first RECEIVED/LATE of the recovery run. */
  get upSince(): number | null {
    return this.link(this.lastNow).upSince;
  }

  /** §5 window statistics. Callers pick idleOnly per §4.8 (≥ 10 idle received in 60 s). */
  stats(windowMs: number, idleOnly: boolean, now: number = this.lastNow): StreamStats {
    return streamStats(this.sorted(), windowMs, idleOnly, now);
  }

  /** §4.8: tag samples whose send time falls in [fromAt, toAt] as loaded, now and when created later. */
  markLoaded(fromAt: number, toAt: number): void {
    this.loadedSpans.push([fromAt, toAt]);
    for (const s of this.ring.toArray()) if (s.at >= fromAt && s.at <= toAt) s.loaded = true;
  }

  /** Last n settled samples oldest → newest; null = LOST (UNMEASURED omitted). */
  rttHistory(n: number): (number | null)[] {
    return rttHistoryOf(this.sorted(), n);
  }

  /** §5 blips: LOST runs of 1–2 that ended with a reply, starting within the window. */
  blips(windowMs: number, now: number = this.lastNow): number {
    return countBlips(this.settled(0), now - windowMs);
  }

  // ---- internals ------------------------------------------------------------------------

  private sendTime(seq: number): number {
    return (this.epoch ?? 0) + seq * PING_INTERVAL_MS;
  }

  /** Highest seq the process has sent by `now`, extrapolated from the last seq seen (§4.2). */
  private maxSent(now: number): number {
    return this.maxSeq + Math.floor((now - this.sendTime(this.maxSeq)) / PING_INTERVAL_MS);
  }

  private firstSynthSeq(now: number): number {
    return Math.max(0, Math.ceil((now - SYNTH_LOOKBACK_MS - (this.epoch ?? 0)) / PING_INTERVAL_MS));
  }

  private beginGeneration(gen: number, at: number, e: PingEvent): void {
    if (this.epoch !== null) {
      // pending seqs of the old generation become UNMEASURED (§4.2)
      const last = this.maxSent(at);
      for (let seq = this.firstSynthSeq(at); seq <= last; seq++) {
        if (!this.records.has(seq)) this.create(seq, 'UNMEASURED', null, true);
      }
    }
    this.gen = gen;
    this.records = new Map();
    this.maxSeq = -1;
    this.missedMax = 0;
    this.nReceived = 0;
    if (e.kind === 'reply' && !e.dup) this.epoch = at - e.rttMs - e.seq * PING_INTERVAL_MS;
    else if (e.kind === 'timeout') this.epoch = at - (e.seq + 1) * PING_INTERVAL_MS; // printed at the next send
    else this.epoch = at + PING_SEND_EPOCH_OFFSET_MS; // header / spawn marker ≈ spawn time
  }

  private onReply(seq: number, rttMs: number, dup: boolean, at: number): void {
    if (!dup && this.epoch !== null) {
      const measured = at - rttMs - seq * PING_INTERVAL_MS;
      this.epoch += PING_EPOCH_EWMA_ALPHA * (measured - this.epoch);
    }
    this.maxSeq = Math.max(this.maxSeq, seq);
    const rec = this.records.get(seq);
    if (!rec) {
      this.create(seq, 'RECEIVED', rttMs, false);
      this.nReceived++;
    } else if (rec.state === 'LOST' || rec.state === 'UNMEASURED') {
      rec.state = 'LATE';
      rec.rttMs = rttMs;
      rec.synthesized = false;
      this.nReceived++;
    } // RECEIVED/LATE already → duplicate, ignore
  }

  private onTimeout(seq: number): void {
    this.maxSeq = Math.max(this.maxSeq, seq);
    // ping prints this at the send of seq + 1, when its cumulative deficit is seq + 1 − nreceived
    this.missedMax = Math.max(this.missedMax, seq + 1 - this.nReceived);
    const rec = this.records.get(seq);
    if (!rec) {
      this.create(seq, 'LOST', null, false);
    } else if (rec.state === 'UNMEASURED') {
      rec.state = 'LOST';
      rec.synthesized = false;
    } // RECEIVED/LATE/LOST → ignore
  }

  private create(seq: number, state: SampleState, rttMs: number | null, synthesized: boolean): PingSample {
    const at = this.sendTime(seq);
    const loaded = this.loadedSpans.some(([from, to]) => at >= from && at <= to);
    const s: PingSample = { gen: this.gen, seq, state, rttMs, at, loaded, synthesized };
    this.records.set(seq, s);
    this.ring.push(s);
    this.sortedCache = null;
    return s;
  }

  /**
   * True while real ping would print nothing: its cumulative missing count has not passed the
   * largest deficit it already reported (nmissedmax), so silence is expected and the missing
   * seqs are loss — not evidence that the process is stuck (§4.2).
   */
  private silenceExpected(now: number): boolean {
    return this.epoch !== null && this.maxSent(now) - this.nReceived <= this.missedMax;
  }

  /** §4.2 deadline backstop: seqs past send + 2 s with no record → LOST (UNMEASURED when stalled). */
  private synthesize(now: number, stalled: boolean): void {
    if (this.epoch === null) return;
    const state: SampleState = stalled ? 'UNMEASURED' : 'LOST';
    const last = this.maxSent(now);
    for (let seq = this.firstSynthSeq(now); seq <= last; seq++) {
      if (this.records.has(seq)) continue;
      if (this.sendTime(seq) + SETTLE_DEADLINE_MS < now) this.create(seq, state, null, true);
    }
  }

  /**
   * A synthesized LOST whose timeout line would have printed after the last real line (at the
   * next send, at + 1 s) was never verified by the process — during a stall that is "couldn't
   * measure", not loss.
   */
  private unverifiedToUnmeasured(): void {
    for (const r of this.records.values()) {
      if (r.synthesized && r.state === 'LOST' && r.at + PING_INTERVAL_MS > this.lastLineAt) r.state = 'UNMEASURED';
    }
  }

  private sorted(): PingSample[] {
    if (!this.sortedCache) this.sortedCache = this.ring.toArray().sort(bySendTime);
    return this.sortedCache;
  }

  private link(now: number): LinkFold {
    if (this.linkCache && this.linkCache.now === now) return this.linkCache.fold;
    let fold = foldLink(this.settled(this.foldSince));
    if (this.localErrorAt !== null && now - this.localErrorAt <= LOCAL_ERROR_WINDOW_MS) {
      fold = { link: 'down', downSince: fold.downSince ?? this.localErrorAt, upSince: null }; // §6.1
    }
    this.linkCache = { now, fold };
    return fold;
  }
}
