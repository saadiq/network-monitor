// §8.7 terminal bell on confirmed transitions. Side effects go only through the injected sink.
import { BELL_COUNTS, BELL_MIN_GAP_MS } from '../config';
import { isOffline, type Transition } from '../model/types';
import { CSI } from '../ui/ansi';

export type BellSink = (s: string) => void;

/** Bells for a confirmed transition: → DOWN/NO_LINK 1, → PORTAL 2, outage → UP/DEGRADED 2, else 0. */
export function bellCount(t: Pick<Transition, 'from' | 'to'>): number {
  if (t.to === 'DOWN') return BELL_COUNTS.DOWN;
  if (t.to === 'NO_LINK') return BELL_COUNTS.NO_LINK;
  if (t.to === 'PORTAL') return BELL_COUNTS.PORTAL;
  if ((t.to === 'UP' || t.to === 'DEGRADED') && isOffline(t.from)) return BELL_COUNTS.RECOVER;
  return 0;
}

export class Alerter {
  private lastBurstAt: number | null = null;

  /** `sink` receives the raw `\x07` burst (stdout, or the TTY writer). `enabled=false` for --no-bell. */
  constructor(private readonly sink: BellSink, private on: boolean = true) {}

  get enabled(): boolean {
    return this.on;
  }

  set enabled(v: boolean) {
    this.on = v;
  }

  /** `b` key. Returns the new state. */
  toggle(): boolean {
    this.on = !this.on;
    return this.on;
  }

  /**
   * Ring for a confirmed transition; at most one burst per BELL_MIN_GAP_MS (§8.7).
   * Returns the number of bells written (0 when off, silent, or rate-limited).
   */
  onTransition(t: Transition, now: number = t.at): number {
    if (!this.on) return 0;
    const n = bellCount(t);
    if (n === 0) return 0;
    if (this.lastBurstAt !== null && now - this.lastBurstAt < BELL_MIN_GAP_MS) return 0;
    this.lastBurstAt = now;
    this.sink(CSI.BELL.repeat(n));
    return n;
  }
}
