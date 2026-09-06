// §5 / §6.3 outage records, sleep close, drop stats and timeline buckets. Pure; `now` injected.
import { WIN_HISTORY_MS } from '../config';
import { RingBuffer } from '../core/ring';
import { mean, median } from '../core/stats';
import type { CellState, DropStats, Outage, State, Transition } from './types';
import { isOffline } from './types';

const MIN15_MS = WIN_HISTORY_MS; // 900 s: drops15, uptime15, timeline
const MIN60_MS = 3_600_000; // drops60, uptime60
const UNDER_S = 30; // dropUnder30
const STEP_MS = 1000; // one history entry per tick

interface Rec extends Outage { startedAtMono: number; endedAtMono: number | null }
interface Hist { at: number; state: CellState }

/** Worst-state ranking for timeline cells (§8.1); GAP/WARMUP only show when nothing else was measured. */
const RANK: Readonly<Record<CellState, number>> = { GAP: 1, WARMUP: 2, UP: 3, DEGRADED: 4, PORTAL: 5, DOWN: 6, NO_LINK: 7 };

export class OutageTracker {
  private readonly hist: RingBuffer<Hist>;
  private readonly done: Rec[] = []; // closed, oldest → newest
  private cur: Rec | null = null;
  private offset: number; // wall − mono, refreshed by transitions / tick(wall)
  private count = 0;

  /** History covers an hour (uptime60); the timeline reads the last 15 min of it. */
  constructor(now = 0, wall = now, historyS = MIN60_MS / STEP_MS + 60) {
    this.hist = new RingBuffer<Hist>(historyS, (h) => h.at);
    this.offset = wall - now;
  }

  get open(): Outage | null { return this.cur; }

  /** Closed outages, newest first (sleep-closed included, flagged). */
  outages(): Outage[] { return [...this.done].reverse(); }

  /** Open/close on confirmed transitions; returns the outage closed by this transition, if any. */
  onTransition(t: Transition): Outage | null {
    this.offset = t.wall - t.at;
    let closed: Outage | null = null;
    if (this.cur) {
      if (isOffline(t.to)) {
        if (this.cur.cause === 'uplink' && t.to === 'PORTAL') { // §6.3 rewrite
          this.cur.cause = 'portal';
          this.cur.state = 'PORTAL';
        }
      } else {
        closed = this.close(t.startedAtMono, t.startedAt, t.to === 'WARMUP');
      }
    } else if (isOffline(t.to)) {
      this.cur = {
        n: ++this.count, state: t.to, cause: t.cause, startedAt: t.startedAt, endedAt: null,
        durationS: secs(t.startedAtMono, t.at), sleep: false, startedAtMono: t.startedAtMono, endedAtMono: null,
      };
    }
    if (t.to !== 'WARMUP') this.rewrite(t.startedAtMono, t.to);
    return closed;
  }

  /** §6.3 sleep: close the open outage at the gap start (sleep=true) and mark the gap unmeasured. */
  onGap(from: number, to: number): Outage | null {
    const closed = this.cur ? this.close(from, from + this.offset, true) : null;
    for (let at = Math.max(from + STEP_MS, to - MIN60_MS); at < to; at += STEP_MS) this.hist.push({ at, state: 'GAP' });
    return closed;
  }

  /** Once per tick with the confirmed state. */
  tick(state: State, now: number, wall?: number): void {
    if (wall != null) this.offset = wall - now;
    this.hist.push({ at: now, state });
    this.hist.evictBefore(now - MIN60_MS - STEP_MS);
    if (this.cur) this.cur.durationS = secs(this.cur.startedAtMono, now);
  }

  /** §5 drop statistics over closed, non-sleep outages. */
  stats(now: number): DropStats {
    const drops = this.done.filter((o) => !o.sleep);
    const durs = drops.map((o) => o.durationS);
    const gaps: number[] = [];
    for (let i = 1; i < drops.length; i++) {
      gaps.push(((drops[i] as Rec).startedAtMono - ((drops[i - 1] as Rec).endedAtMono ?? 0)) / 1000);
    }
    const last = drops[drops.length - 1];
    const up = this.uptime(now);
    return {
      drops15: drops.filter((o) => o.startedAtMono >= now - MIN15_MS).length,
      drops60: drops.filter((o) => o.startedAtMono >= now - MIN60_MS).length,
      dropsSession: drops.length,
      dropMedianS: median(durs),
      dropLongestS: durs.length > 0 ? Math.max(...durs) : null,
      dropUnder30: durs.filter((d) => d < UNDER_S).length,
      dropGapS: gaps.length > 0 ? Math.round(mean(gaps) ?? 0) : null,
      sinceLastDrop: last ? Math.max(0, Math.floor((now - (last.endedAtMono ?? now)) / 1000)) : null,
      uptime15: up.u15,
      uptime60: up.u60,
    };
  }

  /** §8.1 timeline: `cells` buckets of `cellMs` ending at `now`, oldest → newest, worst state per cell. */
  timeline(now: number, cells: number, cellMs: number): CellState[] {
    const out: CellState[] = new Array<CellState>(cells).fill('GAP');
    const rank: number[] = new Array<number>(cells).fill(0);
    const start = now - cells * cellMs;
    for (const h of this.hist.since(start)) {
      const i = Math.ceil((h.at - start) / cellMs) - 1; // cell i covers (start + i·cellMs, start + (i+1)·cellMs]
      if (i < 0 || i >= cells) continue;
      const r = RANK[h.state];
      if (r > (rank[i] ?? 0)) {
        rank[i] = r;
        out[i] = h.state;
      }
    }
    return out;
  }

  private close(endMono: number, endWall: number, sleep: boolean): Outage {
    const o = this.cur as Rec;
    const end = Math.max(endMono, o.startedAtMono);
    o.endedAtMono = end;
    o.endedAt = endWall;
    o.durationS = secs(o.startedAtMono, end);
    o.sleep = sleep;
    this.done.push(o);
    this.cur = null;
    return o;
  }

  /** Backdate: history entries since `fromMono` take the confirmed state (gaps stay gaps). */
  private rewrite(fromMono: number, state: State): void {
    for (const h of this.hist.since(fromMono)) if (h.state !== 'GAP') h.state = state;
  }

  // §5 uptime: down = seconds in DOWN/PORTAL/NO_LINK; measured = seconds not WARMUP and not in a gap.
  private uptime(now: number): { u15: number | null; u60: number | null } {
    let m15 = 0, d15 = 0, m60 = 0, d60 = 0;
    for (const h of this.hist.since(now - MIN60_MS)) {
      if (h.state === 'GAP' || h.state === 'WARMUP') continue;
      const down = isOffline(h.state) ? 1 : 0;
      m60++;
      d60 += down;
      if (h.at >= now - MIN15_MS) {
        m15++;
        d15 += down;
      }
    }
    const pct = (m: number, d: number): number | null => (m > 0 ? (1 - d / m) * 100 : null);
    return { u15: pct(m15, d15), u60: pct(m60, d60) };
  }
}

function secs(fromMono: number, toMono: number): number {
  return Math.max(0, Math.round((toMono - fromMono) / 1000));
}
