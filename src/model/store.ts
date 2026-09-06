// §13 Store: the sample windows, latest probe results, state machine, outage tracker and
// smoothing state. `tick()` advances streams → signals → status → outages once per second and
// builds the Snapshot (snapshot.ts). Pure apart from its own state: clocks are injected.
import { BIN, GAP_MS, LOADED_KBS, LOADED_SPEED_WINDOW_MS, PING_INTERVAL_MS, RATE_HISTORY_N, WIN_TREND_MS } from '../config';
import type { SessionTotals } from '../probes/counters';
import type {
  CounterSample, DnsPair, HttpResult, HttpsResult, PingEvent, RouteInfo, SpeedResult, Timed, WifiInfo,
} from '../probes/types';
import { glyphs, type Glyphs } from '../ui/ansi';
import { Budget } from './budget';
import { GradeHold } from './grade';
import { OutageTracker } from './outages';
import { SampleWindow } from './samples';
import { SAT_OFF, type SatState } from './satellite';
import { deriveSignals, type SignalInputs, type StreamLink } from './signals';
import { computeSnapshot } from './snapshot';
import { StatusMachine } from './status';
import type { Outage, Signals, Snapshot, State, Transition } from './types';

export type { Snapshot } from './types';
export { computeSnapshot } from './snapshot';

/** Stream liveness for this tick (from the PingStreams; the store owns no processes). */
export interface StreamHealth {
  inetStalled: boolean; // PingStream.stalled(now)
  gwStalled: boolean;
  gwActive: boolean; // gateway stream running (a pingGateway is known, §10)
}

export interface TickOutcome {
  snap: Snapshot;
  transitions: Transition[]; // confirmed this tick (a sleep gap adds the WARMUP one first)
  closed: Outage[]; // outages closed this tick (sleep-closed included)
  gap: { fromWall: number; toWall: number } | null; // §6.3 sleep gap this tick
}

export interface StoreOpts {
  target: string;
  now: number; // monotonic ms at start
  wall: number; // epoch ms at start
  ascii?: boolean;
  missingBins?: string[];
}

const NO_HEALTH: StreamHealth = { inetStalled: true, gwStalled: true, gwActive: false };
const UNKNOWN_LINK: StreamLink = { link: 'unknown', downSince: null, upSince: null, lastReceivedAt: null };
const KEEP_CAPTIVE = 3; // §6.1 portal rule reads the last three captive results

const isSteady = (s: State): boolean => s === 'UP' || s === 'DEGRADED';

/** Newest RECEIVED/LATE send time (clears the ICMP-blocked latch, §6.1). */
export function lastReceivedAt(win: SampleWindow, now: number, lookbackMs: number): number | null {
  const settled = win.settled(now - lookbackMs);
  for (let i = settled.length - 1; i >= 0; i--) {
    const s = settled[i];
    if (s && (s.state === 'RECEIVED' || s.state === 'LATE')) return s.at;
  }
  return null;
}

function pushHistory(hist: (number | null)[], v: number | null): void {
  hist.push(v);
  if (hist.length > RATE_HISTORY_N) hist.splice(0, hist.length - RATE_HISTORY_N);
}

export class Store {
  readonly target: string;
  readonly glyphs: Glyphs;
  readonly missingBins: string[];
  readonly startedAt: number;
  readonly startedWall: number;
  readonly inetWin = new SampleWindow();
  readonly gwWin = new SampleWindow();
  readonly hold = new GradeHold();
  readonly status: StatusMachine;
  readonly tracker: OutageTracker;
  readonly budget = new Budget();
  sat: SatState = SAT_OFF;
  // probes
  captive: HttpResult[] = []; // last 3, oldest → newest
  https: HttpsResult | null = null;
  webFailStreak = 0;
  dns: DnsPair | null = null;
  dnsSysOkAt: number | null = null;
  dnsDirectOkAt: number | null = null;
  dnsServer: string | null = null;
  probeErrs = 0; // DNS PROBE_ERROR results (§5 errs)
  route: RouteInfo | null = null;
  wifi: Timed<WifiInfo> | null = null;
  wifiEnabled = false; // §4.1.5 Wi-Fi is the egress or a VPN is active
  counters: CounterSample | null = null;
  totals: SessionTotals = { sessionIn: 0, sessionOut: 0 };
  readonly inHistory: (number | null)[] = [];
  readonly outHistory: (number | null)[] = [];
  speed: Timed<SpeedResult> | null = null;
  speedStartedAt: number | null = null;
  speedEndedAt: number | null = null;
  // per-tick
  sig: Signals;
  prevSig: Signals | null = null;
  prevTick: number;
  wall: number;
  gapMs = 0;
  monoAdjust = 0; // §6.3: sleep the monotonic clock did not count (mono → outage/timeline time)
  steadyAt: number; // §5 steadyFor: backdated start of the last transition into UP/DEGRADED
  lastSnap: Snapshot | null = null;

  constructor(o: StoreOpts) {
    this.target = o.target;
    this.glyphs = glyphs(o.ascii === true);
    this.missingBins = [...(o.missingBins ?? [])];
    this.startedAt = o.now;
    this.startedWall = o.wall;
    this.prevTick = o.now;
    this.wall = o.wall;
    this.steadyAt = o.now;
    this.status = new StatusMachine(o.now, o.wall);
    this.tracker = new OutageTracker(o.now, o.wall);
    this.sig = deriveSignals(this.signalInputs(o.now, 0, NO_HEALTH), o.now);
  }

  /** Outage/timeline time: mono ms + sleep a paused mono clock missed (§6.3; macOS stops it). */
  effNow(now: number): number {
    return now + this.monoAdjust;
  }

  /** Latest captive result. */
  get http(): HttpResult | null {
    return this.captive[this.captive.length - 1] ?? null;
  }

  // ---- probe events (called by the pollers / streams) --------------------------------------

  onPingEvent(stream: 'gw' | 'inet', e: PingEvent, at: number, gen: number): void {
    (stream === 'gw' ? this.gwWin : this.inetWin).onEvent(e, at, gen);
    if ((e.kind === 'reply' && !e.dup) || e.kind === 'timeout') this.budget.add('ping'); // §4.10
  }

  onRoute(info: RouteInfo): void {
    this.route = info;
  }

  onHttp(r: HttpResult): void {
    this.captive = [...this.captive, r].slice(-KEEP_CAPTIVE);
    this.webFailStreak = r.kind === 'fail' ? this.webFailStreak + 1 : 0; // §4.3
    this.budget.add('captive');
  }

  onHttps(r: HttpsResult): void {
    this.https = r;
    this.budget.add('https');
  }

  onDns(pair: DnsPair): void {
    this.dns = pair;
    if (pair.sys.ok) this.dnsSysOkAt = pair.at;
    if (pair.direct.ok) this.dnsDirectOkAt = pair.at;
    if (pair.sys.server) this.dnsServer = pair.sys.server; // §4.5 header resolver
    if (pair.sys.err === 'PROBE_ERROR') this.probeErrs++;
    if (pair.direct.err === 'PROBE_ERROR') this.probeErrs++;
    this.budget.add('dns');
  }

  onWifi(info: Timed<WifiInfo>): void {
    this.wifi = info;
  }

  setWifiEnabled(on: boolean): void {
    this.wifiEnabled = on;
  }

  /** §4.7 sample; §4.8 loaded tagging when in + out exceeds LOADED_KBS. */
  onCounters(sample: CounterSample, totals: SessionTotals): void {
    this.counters = sample;
    this.totals = totals;
    pushHistory(this.inHistory, sample.inKBs);
    pushHistory(this.outHistory, sample.outKBs);
    if ((sample.inKBs ?? 0) + (sample.outKBs ?? 0) > LOADED_KBS) this.markLoaded(sample.at - PING_INTERVAL_MS, sample.at);
  }

  onSpeedStart(now: number): void {
    this.speedStartedAt = now;
    this.speedEndedAt = null;
    this.markLoaded(now - LOADED_SPEED_WINDOW_MS, now + LOADED_SPEED_WINDOW_MS);
  }

  onSpeed(r: SpeedResult, at: number): void {
    this.speed = { ...r, at };
    this.speedEndedAt = at;
    this.budget.add('speed', r.bytes); // §4.10 bytes actually transferred + overhead
    this.markLoaded((this.speedStartedAt ?? at) - LOADED_SPEED_WINDOW_MS, at + LOADED_SPEED_WINDOW_MS);
  }

  /** Per-second RTTs of the newest settled sample per stream (§11 tick row). */
  latestRtts(): { gwRtt: number | null; inetRtt: number | null } {
    return { gwRtt: this.gwWin.rttHistory(1)[0] ?? null, inetRtt: this.inetWin.rttHistory(1)[0] ?? null };
  }

  // ---- the tick ----------------------------------------------------------------------------

  /** Advance one second: gap handling, windows, signals, state, outages, then the Snapshot. */
  tick(now: number, wall: number, gapMs: number, health: StreamHealth): TickOutcome {
    const out: TickOutcome = { snap: this.lastSnap as Snapshot, transitions: [], closed: [], gap: null };
    const slept = gapMs >= GAP_MS;
    if (slept) this.handleGap(now, wall, out); // §6.3 sleep
    // on the gap tick nothing was measurable: a stale pre-sleep line must not synthesize LOST
    this.inetWin.tick(now, health.inetStalled || slept);
    this.gwWin.tick(now, health.gwStalled || !health.gwActive || slept);
    const sig = deriveSignals(this.signalInputs(now, gapMs, health), now);
    this.sig = sig;
    this.wall = wall;
    this.gapMs = gapMs;
    const t = this.status.tick(sig, now, wall); // the state machine stays in raw monotonic time
    if (t) this.applyTransition(t, out);
    this.tracker.tick(this.status.state, this.effNow(now), wall);
    this.prevSig = sig;
    this.prevTick = now;
    out.snap = computeSnapshot(this, now);
    this.lastSnap = out.snap;
    return out;
  }

  private applyTransition(t: Transition, out: TickOutcome): void {
    out.transitions.push(t);
    const closed = this.tracker.onTransition(this.effTransition(t));
    if (closed) out.closed.push(closed);
    if (isSteady(t.to) && !isSteady(t.from)) this.steadyAt = this.effNow(t.startedAtMono);
  }

  /** The tracker keys history and outages by effNow, so a transition's mono times shift too. */
  private effTransition(t: Transition): Transition {
    if (this.monoAdjust === 0) return t;
    return { ...t, at: this.effNow(t.at), startedAtMono: this.effNow(t.startedAtMono) };
  }

  /** §6.3: close the open outage as sleep, mark the gap, pass through WARMUP, forget stale evidence. */
  private handleGap(now: number, wall: number, out: TickOutcome): void {
    const from = this.effNow(this.prevTick);
    this.monoAdjust += Math.max(0, wall - this.wall - (now - this.prevTick)); // paused mono clock
    const to = this.effNow(now);
    const closed = this.tracker.onGap(from, to);
    if (closed) out.closed.push(closed);
    const t = this.status.onGap(this.prevTick, now, wall);
    if (t) {
      out.transitions.push(t);
      this.tracker.onTransition(this.effTransition(t));
    }
    this.forgetEvidence(now);
    out.gap = { fromWall: this.wall, toWall: wall }; // this.wall is still the pre-gap tick's
  }

  /** §6.3: nothing measured before the sleep may drive the first post-wake verdict. */
  private forgetEvidence(now: number): void {
    this.inetWin.onGap(now);
    this.gwWin.onGap(now);
    this.captive = [];
    this.https = null;
    this.webFailStreak = 0;
    this.dns = null;
    this.dnsSysOkAt = null;
    this.dnsDirectOkAt = null;
    this.wifi = null;
    this.prevSig = null; // drops the icmpBlocked / gwNoIcmp / portal / grace latches
  }

  private signalInputs(now: number, gapMs: number, health: StreamHealth): SignalInputs {
    return {
      gw: health.gwActive ? this.linkOf(this.gwWin, now) : UNKNOWN_LINK,
      inet: this.linkOf(this.inetWin, now),
      captive: this.captive,
      https: this.https,
      webFailStreak: this.webFailStreak,
      dnsSysOkAt: this.dnsSysOkAt,
      dnsDirectOkAt: this.dnsDirectOkAt,
      // dig missing, or no DNS round finished yet: "unknown" is not "failing" (avoids a DEGRADED(dns) flash at start)
      dnsDisabled: this.missingBins.includes(BIN.dig) || this.dns === null,
      route: this.route,
      wifi: this.wifiEnabled ? this.wifi : null,
      heldGrade: this.hold.grade,
      gapMs,
      prev: this.prevSig,
    };
  }

  private linkOf(win: SampleWindow, now: number): StreamLink {
    return {
      link: win.linkState(now),
      downSince: win.downSince,
      upSince: win.upSince,
      lastReceivedAt: lastReceivedAt(win, now, WIN_TREND_MS),
    };
  }

  private markLoaded(fromAt: number, toAt: number): void {
    this.inetWin.markLoaded(fromAt, toAt);
    this.gwWin.markLoaded(fromAt, toAt);
  }
}
