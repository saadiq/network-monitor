// §7.2 grade: tiers, caps and the 5-tick hold. Pure except GradeHold's own counters.
import { GRADE_TIERS, GRADE_HOLD_TICKS, CAP_RECENT_OUTAGE_MS, CAP_FLAKY_DROPS15, CAP_LOSS300_PCT } from '../config';
import type { StreamStats } from '../probes/types';
import type { Grade, GradeInfo, State } from './types';
import { adjustRtt } from './satellite';

/** Effective inputs after §7.1 offset and §6.1 source selection. null = not applied. */
export interface GradeInputs {
  loss: number | null; // L, % over 60 s
  rtt: number | null; // R = p50 − rttOffset (or rttProxyMs when icmpBlocked)
  p95: number | null; // P95 − rttOffset; null when icmpBlocked (not applied)
  jitter: number | null; // J
}

/** Raw sources the store already has; `gradeInputs` applies the §7.1/§6.1 rules. */
export interface GradeSources {
  inet: Pick<StreamStats, 'p50' | 'p95' | 'jitter' | 'loss60'>;
  gw: Pick<StreamStats, 'jitter' | 'loss60'>;
  icmpBlocked: boolean;
  rttProxyMs: number | null;
  rttOffset: number;
}

/** §7.2 caps context (all from DropStats / Snapshot). */
export interface CapContext {
  sinceLastDrop: number | null; // seconds since the last closed outage ended; null if none
  drops15: number;
  loss300: number | null; // effective loss over 300 s
  icmpBlocked: boolean;
  underLoad: boolean; // §4.8 all-samples fallback
}

const ORDER: readonly Grade[] = ['A', 'B', 'C', 'D'];

function within(v: number | null, limit: number): boolean {
  return v === null || v <= limit;
}

/** §7.2 tier table; null when there is no RTT to grade on. */
export function rawGrade(i: GradeInputs): Grade {
  if (i.rtt === null) return null;
  for (const t of GRADE_TIERS) {
    if (within(i.loss, t.loss) && i.rtt <= t.rtt && within(i.p95, t.p95) && within(i.jitter, t.jitter)) {
      return t.grade;
    }
  }
  return 'D';
}

/** Build GradeInputs: icmpBlocked → HTTP RTT + gateway loss/jitter, else inet minus the sat offset. */
export function gradeInputs(s: GradeSources): GradeInputs {
  if (s.icmpBlocked) return { loss: s.gw.loss60, rtt: s.rttProxyMs, p95: null, jitter: s.gw.jitter };
  return {
    loss: s.inet.loss60,
    rtt: adjustRtt(s.inet.p50, s.rttOffset),
    p95: adjustRtt(s.inet.p95, s.rttOffset),
    jitter: s.inet.jitter,
  };
}

/** Worst of g and max (a cap never improves a grade; null stays null). */
function capAt(g: Grade, max: 'B' | 'C'): Grade {
  if (g === null) return null;
  return ORDER.indexOf(g) < ORDER.indexOf(max) ? max : g;
}

/** §7.2 caps after tiering, in spec order. Tags are computed even when g is null. */
export function applyCaps(g: Grade, ctx: CapContext): { grade: Grade; tags: string[] } {
  const tags: string[] = [];
  let grade = g;
  if (ctx.sinceLastDrop !== null && ctx.sinceLastDrop * 1000 < CAP_RECENT_OUTAGE_MS) {
    grade = capAt(grade, 'B');
    tags.push('recent drop');
  }
  if (ctx.drops15 >= CAP_FLAKY_DROPS15) {
    grade = capAt(grade, 'B');
    tags.push('FLAKY');
  }
  if (ctx.loss300 !== null && ctx.loss300 > CAP_LOSS300_PCT) {
    grade = capAt(grade, 'C');
    tags.push('loss 5m');
  }
  if (ctx.icmpBlocked) {
    grade = capAt(grade, 'B');
    tags.push('icmp');
  }
  if (ctx.underLoad) tags.push('~');
  return { grade, tags };
}

/** §7.2 hold: the displayed grade changes only after GRADE_HOLD_TICKS identical pushes. */
export class GradeHold {
  private held: Grade = null;
  private candidate: Grade = null;
  private run = 0;

  get grade(): Grade {
    return this.held;
  }

  /** Feed this tick's (capped) grade; returns the displayed grade. */
  push(g: Grade): Grade {
    if (g === this.candidate) this.run++;
    else {
      this.candidate = g;
      this.run = 1;
    }
    if (this.run >= GRADE_HOLD_TICKS) this.held = g;
    return this.held;
  }

  /** Entering/leaving a non-graded state (§7.2). */
  reset(): void {
    this.held = null;
    this.candidate = null;
    this.run = 0;
  }
}

/** Only UP and DEGRADED carry a displayed grade. */
export function isGradedState(state: State): boolean {
  return state === 'UP' || state === 'DEGRADED';
}

/** One tick: raw → caps → hold. Non-graded states reset the hold and display null. */
export function computeGrade(inputs: GradeInputs, ctx: CapContext, hold: GradeHold, state: State): GradeInfo {
  const raw = rawGrade(inputs);
  const capped = applyCaps(raw, ctx);
  if (!isGradedState(state)) {
    hold.reset();
    return { grade: null, raw, tags: capped.tags, underLoad: ctx.underLoad };
  }
  return { grade: hold.push(capped.grade), raw, tags: capped.tags, underLoad: ctx.underLoad };
}
