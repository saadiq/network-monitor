// Snapshot and Signals — the per-tick contract between store, model and UI.
import type { HttpKind, HttpResult, HttpsResult, DnsResult, WifiInfo, RouteInfo, SpeedResult, StreamStats } from '../probes/types';
import type { State, Cause, Grade, LinkState, GradeInfo, DropStats, Outage, Trend, Verdict, CellState } from './types';

/** A latest result with its monotonic time and age in seconds (now − at). */
export type Aged<T> = T & { at: number; ageS: number };

/** §6.1 / §6.2 inputs to evaluateCandidate; derived once per tick by deriveSignals. */
export interface Signals {
  now: number; // monotonic ms
  hasRoute: boolean; // §4.1
  routeAt: number | null; // monotonic ms of the last route probe (backdating NO_LINK start/end)
  assoc: 'yes' | 'no' | null; // Wi-Fi association; null = no fresh Wi-Fi info
  selfAssigned: boolean; // 169.254.x address
  rssi: number | null; // dBm
  vpn: boolean;
  gwLink: LinkState; // §6.1 gateway stream hysteresis
  inetLink: LinkState; // §6.1 internet stream hysteresis
  inetDownSince: number | null; // monotonic send time of the first LOST in the down run
  gwDownSince: number | null;
  inetUpSince: number | null; // monotonic send time of the first RECEIVED of the recovery run
  gwUpSince: number | null;
  inetOk: boolean; // §6.2 formula
  icmpBlocked: boolean; // §6.1 latch
  gwNoIcmp: boolean; // §6.1 gwLink down && inetOk (latched once the condition has held)
  /** Monotonic ms the gwNoIcmp condition started holding; null while it is not holding. */
  gwNoIcmpSince: number | null;
  portalSignal: boolean; // §6.1
  portalSince: number | null; // monotonic startedAt of the first portal result of the current signal
  portalRedirectUrl: string | null; // last portal redirectUrl (for the `o` key)
  hasHttpResult: boolean; // any captive result yet (WARMUP row 3)
  lastHttpKind: HttpKind | null;
  httpAgeS: number | null; // seconds since the last captive result started
  httpStartedAt: number | null; // monotonic
  // monotonic startedAt of the first ok of the current trailing ok run (backdating recovery),
  // or of the last ok seen when the newest result is not ok
  lastHttpOkAt: number | null;
  dnsSysOk: boolean; // success within 45 s
  dnsDirectOk: boolean;
  dnsOk: boolean; // either
  webFailStreak: number; // consecutive captive `fail` results
  heldGrade: Grade; // §7.2 displayed grade (row 9)
  grace: boolean; // §6.2 confirmation grace active → candidate held at previous confirmed state
  graceUntil: number | null; // monotonic ms when grace expires
  gapMs: number; // tick gap this tick (≥ GAP_MS means sleep, §6.3)
}

/** Everything the UI, verdicts, banner, tips, logger and quit report read. Built once per tick. */
export interface Snapshot {
  // time
  now: number; // monotonic ms of this tick
  wall: number; // epoch ms of this tick
  startedAt: number; // monotonic ms at process start
  startedWall: number; // epoch ms at process start
  runS: number; // seconds since start
  gapMs: number; // tick gap this tick
  // environment
  target: string; // --target
  route: RouteInfo | null; // latest §4.1 result; null before the first probe
  vpn: boolean; // route?.vpn ?? false
  missingBins: string[]; // absolute paths that failed preflight
  icmpBlocked: boolean; // §6.1 latch
  gwNoIcmp: boolean; // §6.1
  // ping streams (§5); gw/inet use the 60 s window, idle samples preferred (§4.8)
  gw: StreamStats; // gateway stream
  inet: StreamStats; // internet stream
  inetP10_120: number | null; // inet p10 over 120 s (§7.1)
  latencyMs: number | null; // effective p50: inet.p50, or rttProxyMs when icmpBlocked
  latencyP95: number | null; // inet.p95; null when icmpBlocked
  latencySource: 'icmp' | 'http';
  jitter: number | null; // effective: inet, or gateway stream when icmpBlocked
  loss10: number | null; // effective loss %: inet, or gateway stream when icmpBlocked
  loss60: number | null;
  loss300: number | null;
  /** §7.2/§7.4 loss input: loss since the current steady run began, so an outage's own LOST
   *  samples never hold a C/D grade after recovery. null when there is too little to grade on. */
  lossGrade: number | null;
  lossSource: 'inet' | 'router'; // 'router' when icmpBlocked (UI labels "(router)")
  late60: number; // inet LATE count, 60 s
  blips: number; // inet LOST runs of 1–2 not part of an outage, 60 s
  unmeasured60: number; // inet UNMEASURED seconds, 60 s
  errs: number; // PROBE_ERROR + unknown lines, session
  rttHistory: (number | null)[]; // last 60 inet samples oldest→newest; null = LOST (UNMEASURED omitted)
  // http / https / dns
  http: Aged<HttpResult> | null; // last captive result
  httpStale: boolean; // http.ageS > 30
  https: Aged<HttpsResult> | null;
  rttProxyMs: number | null; // http.connectMs (used when icmpBlocked)
  webFailStreak: number;
  dnsDirect: Aged<DnsResult> | null;
  dnsSys: Aged<DnsResult> | null;
  dnsDirectOk: boolean; // success within 45 s
  dnsSysOk: boolean;
  dnsOk: boolean; // either
  dnsServer: string | null; // system-path resolver for the header (100.100.100.100 → "(ts)")
  // wifi (§4.6)
  wifi: Aged<WifiInfo> | null;
  wifiStatus: 'off' | 'reading' | 'ok' | 'stale'; // off = not the egress; reading = no result yet; stale > 150 s
  // traffic (§4.7 / §4.8)
  inKBs: number | null; // this second; null when the delta was skipped
  outKBs: number | null;
  inHistory: (number | null)[]; // last 10 KB/s values oldest→newest
  outHistory: (number | null)[];
  sessionIn: number; // bytes
  sessionOut: number;
  loadedNow: boolean; // this second is loaded
  idleP50: number | null; // inet p50 over idle samples, 60 s
  loadedP50: number | null;
  // state (§6)
  state: State;
  cause: Cause;
  since: number; // monotonic ms of the last confirmed transition
  sinceWall: number; // epoch ms
  steadyFor: number; // seconds since the last transition into UP/DEGRADED (or start)
  downFor: number | null; // seconds since the open outage's backdated start; null when none
  // grade (§7)
  grade: GradeInfo;
  sat: boolean; // §7.1
  rttOffset: number; // ms subtracted from p50/p95 while sat; 0 otherwise
  // outages (§5)
  drops: DropStats;
  outages: Outage[]; // closed outages, newest first (sleep-closed included, flagged)
  openOutage: Outage | null;
  timeline: (cells: number, cellMs: number) => CellState[]; // oldest→newest, worst state per cell
  trend: Trend;
  // speed / budget
  speed: Aged<SpeedResult> | null; // last test (kept for display even after validity)
  speedValid: boolean; // ageS ≤ 600 → usable by verdicts
  probeBytes: number; // session total, both directions
  probeRateEst: number; // bytes per hour estimate
  // derived text (computed after the fields above)
  verdicts: Verdict[]; // CHAT, BROWSE, VIDEO CALL, DOWNLOAD in that order
  signals: Signals;
  tip: string | null;
  banner: [string, string]; // §7.5 lines (untruncated; UI fits to width)
}
