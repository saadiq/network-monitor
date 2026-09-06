// §6.2 candidate table and §6.3 debounce / transitions. Pure; `now` injected.
import { DEBOUNCE_TICKS, RSSI_WIFI_DOWN, WEB_FAIL_STREAK } from '../config';
import type { Candidate, Cause, Signals, State, Transition } from './types';
import { isOffline } from './types';

function noLinkCause(sig: Signals): Cause {
  if (sig.assoc === 'yes' || sig.selfAssigned) return 'no-dhcp';
  if (sig.assoc === 'no') return 'not-joined';
  return 'unknown';
}

/** §6.2 table: first match wins; total. */
export function evaluateCandidate(sig: Signals): Candidate {
  if (!sig.hasRoute) return { state: 'NO_LINK', cause: noLinkCause(sig) }; // 1
  if (sig.portalSignal) return { state: 'PORTAL', cause: 'portal' }; // 2
  if (sig.inetLink === 'unknown' && !sig.hasHttpResult) return { state: 'WARMUP', cause: null }; // 3
  if (!sig.inetOk) {
    if (sig.gwLink === 'down' && !sig.gwNoIcmp) { // §6.1: a no-icmp gateway never implicates the local link
      const weak = sig.assoc === 'no' || (sig.rssi != null && sig.rssi < RSSI_WIFI_DOWN);
      return { state: 'DOWN', cause: weak ? 'wifi' : 'router' }; // 4, 5
    }
    return { state: 'DOWN', cause: 'uplink' }; // 6
  }
  const dnsDead = (!sig.dnsSysOk && !sig.dnsDirectOk) || (sig.lastHttpKind === 'dnsfail' && !sig.dnsSysOk);
  if (dnsDead) return { state: 'DEGRADED', cause: 'dns' }; // 7
  if (sig.webFailStreak >= WEB_FAIL_STREAK && sig.inetLink === 'up') return { state: 'DEGRADED', cause: 'web' }; // 8
  if (sig.heldGrade === 'C' || sig.heldGrade === 'D') return { state: 'DEGRADED', cause: 'quality' }; // 9
  return { state: 'UP', cause: null }; // 10
}

interface Pending { state: State; cause: Cause; count: number }

/**
 * Confirmed state with §6.3 debounce and backdated transition times.
 * Wall time is derived from a (mono, wall) offset refreshed by every call that passes `wall`.
 */
export class StatusMachine {
  private st: State = 'WARMUP';
  private cs: Cause = null;
  private sinceMono: number;
  private eventStart: number; // monotonic, backdated start of the current state
  private offset: number; // wall − mono
  private pending: Pending | null = null;

  constructor(now = 0, wall = now) {
    this.sinceMono = now;
    this.eventStart = now;
    this.offset = wall - now;
  }

  get state(): State { return this.st; }
  get cause(): Cause { return this.cs; }
  /** Monotonic ms of the last confirmed transition. */
  get since(): number { return this.sinceMono; }
  get sinceWall(): number { return this.sinceMono + this.offset; }
  /** Monotonic ms the current state actually began (backdated). */
  get startedAtMono(): number { return this.eventStart; }

  tick(sig: Signals, now: number, wall?: number): Transition | null {
    if (wall != null) this.offset = wall - now;
    let cand = evaluateCandidate(sig);
    if (sig.grace && cand.state === 'DOWN') cand = { state: this.st, cause: this.cs }; // §6.2 grace
    if (cand.state === this.st) {
      this.pending = null;
      // causes are fixed at open for outages (§6.3); DEGRADED may refresh its cause silently
      if (this.st === 'DEGRADED' && cand.cause !== this.cs) this.cs = cand.cause;
      return null;
    }
    if (this.pending && this.pending.state === cand.state) {
      this.pending.count++;
      this.pending.cause = cand.cause;
    } else {
      this.pending = { state: cand.state, cause: cand.cause, count: 1 };
    }
    if (this.pending.count < DEBOUNCE_TICKS[cand.state]) return null;
    this.pending = null;
    return this.transition(cand.state, cand.cause, now, this.backdate(cand, sig, now));
  }

  /** §6.3 sleep: a tick gap [from, to] → WARMUP, backdated to the gap start. */
  onGap(from: number, to: number, wall?: number): Transition | null {
    this.pending = null;
    const startedAt = from + this.offset; // pre-gap offset for the gap start
    if (wall != null) this.offset = wall - to;
    if (this.st === 'WARMUP') return null;
    return this.transition('WARMUP', null, to, from, startedAt);
  }

  // §6.3 backdated event start: the earliest valid evidence inside [current event start, now].
  private backdate(cand: Candidate, sig: Signals, now: number): number {
    const lo = this.eventStart;
    const pick = (xs: (number | null)[]): number => {
      const ok = xs.filter((x): x is number => x != null && x >= lo && x <= now);
      return ok.length > 0 ? Math.min(...ok) : now;
    };
    if (isOffline(cand.state)) {
      if (cand.state === 'NO_LINK') return pick([sig.routeAt]);
      if (cand.state === 'PORTAL') return pick([sig.portalSince]);
      if (cand.cause === 'uplink') return pick([sig.inetDownSince]);
      return pick([sig.gwDownSince ?? sig.inetDownSince]);
    }
    if (isOffline(this.st)) {
      const xs: (number | null)[] = [sig.lastHttpOkAt];
      if (sig.inetLink === 'up') xs.push(sig.inetUpSince);
      if (this.st === 'NO_LINK') xs.push(sig.routeAt);
      return pick(xs);
    }
    return now;
  }

  private transition(to: State, cause: Cause, now: number, startedAtMono: number, startedAt = startedAtMono + this.offset): Transition {
    const t: Transition = { from: this.st, to, cause, at: now, wall: now + this.offset, startedAt, startedAtMono };
    this.st = to;
    this.cs = cause;
    this.sinceMono = now;
    this.eventStart = startedAtMono;
    return t;
  }
}
