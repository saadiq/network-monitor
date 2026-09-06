// Single-flight setTimeout chain shared by the one-shot pollers (§4.1, §4.6, §4.7).
// Side-effecting: timers only. The job does the I/O and returns the next cadence.
import { monoNow } from '../core/clock';

/** Returns the cadence in ms (next start = this start + cadence), or null to stop rescheduling. */
export type PollJob = () => Promise<number | null>;

export class PollLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private done = false;
  private begun = false;
  /** Monotonic ms when the last job started (0 before the first run). */
  lastStart = 0;

  constructor(private readonly job: PollJob, private readonly now: () => number = monoNow) {}

  get inFlight(): boolean {
    return this.busy;
  }

  get pending(): boolean {
    return this.timer !== null;
  }

  get started(): boolean {
    return this.begun;
  }

  get stopped(): boolean {
    return this.done;
  }

  /** Run the job after delayMs, replacing any pending timer. No-op after stop(). */
  schedule(delayMs: number): void {
    if (this.done) return;
    this.begun = true;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, Math.max(0, delayMs));
  }

  /** Schedule so that runs start every cadenceMs, measured from the last start (0 if overdue). */
  scheduleFrom(cadenceMs: number): void {
    this.schedule(this.lastStart + cadenceMs - this.now());
  }

  /** Drop the pending timer without stopping the loop. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.done = true;
    this.cancel();
  }

  /** Run the job now unless one is in flight; the job's returned cadence schedules the next run. */
  async fire(): Promise<void> {
    if (this.busy || this.done) return;
    this.busy = true;
    this.lastStart = this.now();
    let next: number | null = null;
    try {
      next = await this.job();
    } finally {
      this.busy = false;
    }
    if (next !== null) this.scheduleFrom(next);
  }
}
