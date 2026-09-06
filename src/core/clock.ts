// Monotonic / wall time and the 1 s ticker (§13). Side-effecting: timers only.
import { TICK_MS } from '../config';

/** Monotonic ms (performance.now()). Sample windows and ages use this. */
export function monoNow(): number {
  return performance.now();
}

/** Epoch ms (Date.now()). Outage/transition timestamps and display use this. */
export function wallNow(): number {
  return Date.now();
}

/** Convert a monotonic timestamp to epoch ms given a (mono, wall) pair from the same tick. */
export function monoToWall(mono: number, nowMono: number, nowWall: number): number {
  return nowWall - (nowMono - mono);
}

export type TickHandler = (now: number, gapMs: number) => void;

/**
 * 1 s setInterval. onTick(now, gapMs): now = monoNow(), gapMs = elapsed since the
 * previous tick (or since start()). gapMs is max(monotonic Δ, wall Δ) so a laptop
 * sleep is reported even if the monotonic clock paused. Gap handling (§6.3) is the
 * caller's job.
 */
export class Ticker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevMono = 0;
  private prevWall = 0;

  constructor(private readonly intervalMs: number = TICK_MS) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(onTick: TickHandler): void {
    if (this.timer) return;
    this.prevMono = monoNow();
    this.prevWall = wallNow();
    this.timer = setInterval(() => {
      const now = monoNow();
      const wall = wallNow();
      const gapMs = Math.max(now - this.prevMono, wall - this.prevWall, 0);
      this.prevMono = now;
      this.prevWall = wall;
      onTick(now, gapMs);
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
