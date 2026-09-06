// §3 Runtime constants. Every tunable lives here; modules import, never redefine.
import type { State } from './model/types';

// §3 table
export const TICK_MS = 1000;
export const PING_PAYLOAD_BYTES = 16;
export const SETTLE_DEADLINE_MS = 2000;
export const STREAM_STALL_MS = 3000;
export const STREAM_RESTART_MS = 5000;
export const STREAM_BACKOFF_MS: readonly number[] = [1000, 2000, 5000];
export const LINK_DOWN_LOST = 3;
export const LINK_UP_RECEIVED = 2;
export const HTTP_CADENCE_MS = 10000;
export const HTTP_FAST_CADENCE_MS = 3000;
export const HTTP_TIMEOUT_S = 4;
export const HTTP_STALE_MS = 30000;
export const HTTPS_CADENCE_MS = 180000;
export const DNS_CADENCE_MS = 15000;
export const ROUTE_CADENCE_MS = 5000;
export const ROUTE_FAST_CADENCE_MS = 2000;
export const WIFI_CADENCE_MS = 60000;
export const WIFI_KILL_MS = 40000;
export const WIFI_BACKOFF_MS = 120000;
export const WIFI_STALE_MS = 150000;
export const COUNTERS_CADENCE_MS = 1000;
export const WIN_FAST_MS = 10000;
export const WIN_MAIN_MS = 60000;
export const WIN_TREND_MS = 120000;
export const WIN_CAP_MS = 300000;
export const WIN_HISTORY_MS = 900000;
export const ICMP_BLOCKED_AFTER_MS = 30000;
export const SAT_P10_MS = 400;
export const SAT_CLEAR_MS = 300;
export const SAT_LOSS_MAX = 2;
export const GRADE_HOLD_TICKS = 5;
export const SPEED_BYTES = 250000;
export const SPEED_MIN_GAP_MS = 30000;
export const SPEED_VALID_MS = 600000;
export const BELL_MIN_GAP_MS = 5000;
export const GAP_MS = 5000;
export const MIN_COLS = 72;
export const MIN_ROWS = 18;
export const FULL_COLS = 100;
export const FULL_ROWS = 27;
export const LOADED_KBS = 500;

// §3 binaries (absolute; preflight reports missing ones, never crashes)
export const BIN = {
  ping: '/sbin/ping',
  dig: '/usr/bin/dig',
  curl: '/usr/bin/curl',
  netstat: '/usr/sbin/netstat',
  route: '/sbin/route',
  scutil: '/usr/sbin/scutil',
  networksetup: '/usr/sbin/networksetup',
  ipconfig: '/usr/sbin/ipconfig',
  system_profiler: '/usr/sbin/system_profiler',
  open: '/usr/bin/open',
} as const;
export type BinName = keyof typeof BIN;
export const ALL_BINS: readonly string[] = Object.values(BIN);

// §4 per-probe details not in the §3 table
export const DEFAULT_TARGET = '1.1.1.1';
export const CURL_UA = 'netmon/1';
export const ROUTE_TIMEOUT_MS = 3000; // §4.1 route / scutil / ipconfig
export const HWPORTS_TIMEOUT_MS = 5000; // §4.1 networksetup
export const PING_SEND_EPOCH_OFFSET_MS = 20; // §4.2 initial sendEpoch = spawn + 20 ms
export const PING_EPOCH_EWMA_ALPHA = 0.1; // §4.2
export const PING_INTERVAL_MS = 1000; // §4.2 ping -i 1
export const LOCAL_ERROR_WINDOW_MS = 3000; // §6.1 sendto error → link down
export const HTTP_PROCESS_TIMEOUT_MS = 6000; // §4.3
export const HTTPS_TIMEOUT_S = 6; // §4.4 curl -m
export const HTTPS_PROCESS_TIMEOUT_MS = 8000; // §4.4
export const HTTPS_MIN_GAP_MS = 60000; // §4.4 out-of-band at most once per 60 s
export const DNS_TIMEOUT_S = 2; // §4.5 dig +time
export const DNS_PROCESS_TIMEOUT_MS = 4000; // §4.5
export const DNS_FRESH_MS = 45000; // §5 dnsOk = a success within 45 s
export const DNS_DIRECT_SERVER = '1.1.1.1'; // §4.5 @1.1.1.1
export const DNS_NAMES: readonly string[] = ['www.apple.com', 'www.cloudflare.com', 'www.google.com'];
export const DNS_CACHEBUSTER_EVERY = 4; // §4.5 every 4th round: <8 hex>.example.com
export const DNS_CACHEBUSTER_DOMAIN = 'example.com';
export const TAILSCALE_DNS = '100.100.100.100';
export const WIFI_FAILS_BEFORE_BACKOFF = 3; // §4.6
export const SNR_GOOD = 25; // §4.6 good ≥ 25
export const SNR_FAIR = 15; // §4.6 fair 15–24, poor < 15
export const COUNTERS_TIMEOUT_MS = 2000; // §4.7
export const COUNTERS_MAX_DT_MS = 5000; // §4.7 Δt > 5 s → sample skipped
export const RATE_HISTORY_N = 10; // §5 10-sample KB/s sparkline
export const LOADED_SPEED_WINDOW_MS = 2000; // §4.8 ±2 s around a speed test
export const IDLE_MIN_SAMPLES = 10; // §4.8 idle samples preferred when ≥ 10
export const SPEED_TIMEOUT_S = 20; // §4.9 curl -m
export const SPEED_PROCESS_TIMEOUT_MS = 22000; // §4.9
export const SPEED_MIN_BYTES = 200000; // §4.9 size_download ≥ 200000

// §4.3 / §4.4 / §4.9 URLs
export const CAPTIVE_DETECTORS = {
  apple: 'http://captive.apple.com/hotspot-detect.html',
  google: 'http://connectivitycheck.gstatic.com/generate_204',
} as const;
export type Detector = keyof typeof CAPTIVE_DETECTORS;
export const DETECTOR_ORDER: readonly Detector[] = ['apple', 'google'];
export const DEFAULT_PORTAL_URL: string = CAPTIVE_DETECTORS.apple;
export const HTTPS_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
export const SPEED_URL = `https://speed.cloudflare.com/__down?bytes=${SPEED_BYTES}`;

// §4.10 estimated bytes per probe, both directions, IP layer
export const PROBE_BYTES = {
  ping: 88,
  dns: 300, // per dig pair
  captive: 1000,
  https: 5000,
  speedOverhead: 2000, // speed test = size_download + 2000
} as const;
export type ProbeKind = keyof typeof PROBE_BYTES;

// §5 window minimums
export const MIN_SETTLED_FOR_LOSS = 3; // loss null if < 3 settled samples
export const MIN_RTTS_FOR_JITTER = 3; // jitter null if < 3
export const RTT_HISTORY_N = 60; // RTT sparkline samples

// §6 state machine
export const ICMP_BLOCKED_HTTP_OK = 2; // latch needs last 2 captive results ok
export const PORTAL_ENTER_RESULTS = 2; // §4.3 two portal results
export const PORTAL_EXIT_OK = 2; // §4.3 two consecutive ok (one per detector)
export const GRACE_MS = 5000; // §6.2 confirmation grace
export const GRACE_HTTP_FRESH_MS = 10000; // §6.2 previous captive ok ≤ 10 s old
export const GW_NO_ICMP_HOLD_MS = 5000; // §6.1 gwNoIcmp must hold this long before it is carried
export const RSSI_WIFI_DOWN = -85; // §6.2 row 4
export const WEB_FAIL_STREAK = 3; // §6.2 row 8
export const DEBOUNCE_TICKS: Readonly<Record<State, number>> = {
  NO_LINK: 1, PORTAL: 1, WARMUP: 1, DOWN: 2, DEGRADED: 1, UP: 2,
};

// §7.1 satellite
export const SAT_MIN_DATA_MS = 120000; // after ≥ 120 s of inet data
export const SAT_OFFSET_BASE_MS = 100; // rttOffset = round50(max(0, p10 − 100))
export const SAT_RECOMPUTE_MS = 60000;

// §7.2 grade tiers (A, B, C in order; D otherwise) and caps
export interface GradeTier { grade: 'A' | 'B' | 'C'; loss: number; rtt: number; p95: number; jitter: number }
export const GRADE_TIERS: readonly GradeTier[] = [
  { grade: 'A', loss: 1, rtt: 150, p95: 300, jitter: 30 },
  { grade: 'B', loss: 5, rtt: 300, p95: 600, jitter: 60 },
  { grade: 'C', loss: 15, rtt: 800, p95: 1500, jitter: 150 },
];
export const GRADE_WORDS: Readonly<Record<'A' | 'B' | 'C' | 'D', string>> = {
  A: 'GOOD', B: 'OK', C: 'POOR', D: 'BAD',
};
export const GRADE_MIN_SETTLED_FOR_LOSS = 10; // §7.2 below this many settled samples loss is not graded
export const GRADE_LOSS_TIER_SETTLED = 20; // below this many, loss may cost A but never drag below B
export const GRADE_SHORT_RUN_LOSS_CAP: number = GRADE_TIERS[1]?.loss ?? 5; // tier B's own loss limit
export const CAP_RECENT_OUTAGE_MS = 120000; // outage ended < 120 s ago → max B
export const CAP_FLAKY_DROPS15 = 3; // drops15 ≥ 3 → max B + FLAKY
export const CAP_LOSS300_PCT = 10; // loss300 > 10 % → max C

// §7.3 trend
export const TREND_MIN_SAMPLES = 10;
export const TREND_WORSE_RATIO = 1.25;
export const TREND_BETTER_RATIO = 0.8;
export const TREND_MIN_DELTA_MS = 20;
export const TREND_LOSS_DELTA = 3;

// §7.4 verdict thresholds
export const VERDICT = {
  reasonMax: 28,
  justBackS: 30, // sinceDrop < 30 → "just came back"
  chat: { loss: 15, rtt: 1500 },
  browse: { loss: 8, rtt: 600, httpMs: 2000, dnsSysMs: 500 },
  video: {
    ok: { loss: 3, jitter: 50, rtt: 250, sinceDropS: 300, drops15: 1, minMbps: 1.5 },
    shaky: { loss: 8, jitter: 100, rtt: 400, sinceDropS: 60 },
    audioOk: { loss: 5, jitter: 60 },
  },
  download: {
    ok: { uptime15: 97, sinceDropS: 300, minMbps: 8 },
    shaky: { uptime15: 85, drops15: 2 },
  },
} as const;

// §7.6 tips
export const TIP_WEAK_RSSI = -80;
export const TIP_DNS_SLOW_RATIO = 4;
export const TIP_DNS_SLOW_MS = 200;
export const TIP_PORTAL_OUTAGES = 2;
export const TIP_PORTAL_WINDOW_MS = 1800000;

// §8 UI
export const METRIC_CELL_W = 24;
export const METRIC_CELL_START = 3;
export const TIMELINE_FULL = { cells: 90, cellMs: 10000 } as const;
export const TIMELINE_COMPACT = { cells: 60, cellMs: 15000 } as const;
export const FLASH_TICKS = 2; // banner inverse after a transition
export const MAX_FPS = 4;
export const BELL_COUNTS = { DOWN: 1, NO_LINK: 1, PORTAL: 2, RECOVER: 2 } as const;
export const LOG_PREFIX = 'netmon-'; // §11 ~/netmon-YYYYMMDD-HHMM.jsonl
export const LOG_VERSION = 1;
