// §5–§8 model types. Plain data; the only runtime export is `isOffline`.
// Time convention: `at`/`since` = monotonic ms; `wall`/`startedAt`/`endedAt` on
// outages and transitions = epoch ms (survive sleep gaps and are printable).
export type { Aged, Signals, Snapshot } from './types-snapshot';

export type State = 'UP' | 'DEGRADED' | 'DOWN' | 'PORTAL' | 'NO_LINK' | 'WARMUP';

export type Cause =
  | 'not-joined' | 'no-dhcp' | 'unknown' // NO_LINK
  | 'portal' // PORTAL
  | 'wifi' | 'router' | 'uplink' // DOWN
  | 'dns' | 'web' | 'quality' // DEGRADED
  | null; // UP / WARMUP

export type Grade = 'A' | 'B' | 'C' | 'D' | null;

/** §6.1 per-stream link state. */
export type LinkState = 'up' | 'down' | 'unknown';

/** States that count as an outage (§7.4 offline, §5 uptime "down"). */
export type OfflineState = 'DOWN' | 'PORTAL' | 'NO_LINK';

export function isOffline(s: State): s is OfflineState {
  return s === 'DOWN' || s === 'PORTAL' || s === 'NO_LINK';
}

/** §6.2 output of evaluateCandidate. */
export interface Candidate { state: State; cause: Cause }

/** §6.3 confirmed transition. */
export interface Transition {
  from: State;
  to: State;
  cause: Cause; // cause of `to`
  at: number; // monotonic ms when confirmed
  wall: number; // epoch ms when confirmed
  startedAt: number; // epoch ms, backdated event start (§6.3)
  startedAtMono: number; // monotonic ms, backdated event start
}

/** §5 / §6.3 outage record. */
export interface Outage {
  n: number; // 1-based session index
  state: OfflineState; // DOWN / PORTAL / NO_LINK (timeline color)
  cause: Cause; // fixed at open; DOWN(uplink) → PORTAL rewrites to 'portal'
  startedAt: number; // epoch ms, backdated
  endedAt: number | null; // epoch ms, backdated; null while open
  durationS: number; // seconds so far (open) or total (closed)
  sleep: boolean; // closed by a tick gap; excluded from drop stats
}

/** §5 drop statistics (closed, non-sleep outages). */
export interface DropStats {
  drops15: number; // closed outages started in the last 15 min
  drops60: number; // last 60 min
  dropsSession: number;
  dropMedianS: number | null; // null when no drops
  dropLongestS: number | null;
  dropUnder30: number; // count with durationS < 30
  dropGapS: number | null; // mean end→next start seconds; null if < 2 drops
  sinceLastDrop: number | null; // seconds since the last outage ended; null if none
  uptime15: number | null; // 1 − down/measured × 100; null when nothing measured
  uptime60: number | null;
}

/** §7.3 trend. */
export type TrendDir = 'better' | 'worse' | 'flat' | null; // null = insufficient data
export interface Trend {
  latency: TrendDir;
  loss: TrendDir;
  overall: 'worse' | 'better' | null; // any worse & none better → worse; vice versa → better
  phrase: string | null; // 'getting worse' / 'improving' (UI appends ▲/▼)
  p50Last: number | null; // last 60 s
  p50Prior: number | null; // prior 60 s
  lossLast: number | null;
  lossPrior: number | null;
}

/** §7.4 activity verdict. */
export type ActivityName = 'CHAT' | 'BROWSE' | 'VIDEO CALL' | 'DOWNLOAD';
export type VerdictLevel = 'OK' | 'SHAKY' | 'NO' | '?';
export interface Verdict {
  name: ActivityName;
  level: VerdictLevel;
  reason: string; // ≤ 28 chars; '' when OK without a note
}

/** §7.2 grade with hold and caps applied. */
export interface GradeInfo {
  grade: Grade; // displayed (held) grade; null in non-graded states / before data
  raw: Grade; // this tick's uncapped tier
  tags: string[]; // e.g. 'FLAKY', 'recent drop', 'loss 5m', 'icmp'
  underLoad: boolean; // §4.8 all-samples fallback → suffix `~`
}

/** §8.1 timeline cell. */
export type CellState = 'UP' | 'DEGRADED' | 'PORTAL' | 'DOWN' | 'NO_LINK' | 'GAP' | 'WARMUP';

/** UI-only state owned by main/tty, passed to banner/footer alongside the Snapshot. */
/** Which TUI screen is drawn (simple-view spec §2): 'simple' by default, 'advanced' with --advanced; `v` toggles. */
export type View = 'simple' | 'advanced';

export interface UiState {
  view: View;
  bellOn: boolean;
  flashTicksLeft: number; // > 0 → banner rendered inverse (§8.1)
  footerMsg: string | null; // transient footer message (e.g. speed test refusal)
  footerMsgUntil: number | null; // monotonic ms after which footerMsg clears
  lastSpeed: number | null; // monotonic ms when the last speed test started (rate limit)
  speedRunning: boolean;
  logStatus: string | null; // null = logging off; 'on' or 'off (EACCES)' (§10)
}
