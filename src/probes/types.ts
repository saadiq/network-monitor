// §4 probe result types. Plain data only. Times: `at`/`startedAt` are monotonic ms
// (core/clock monoNow) unless a field says "wall" (epoch ms).

/** Adds the monotonic sample time. Pollers stamp pure parse results with it. */
export type Timed<T> = T & { at: number };

// §4.2 ping line events
export type PingEvent =
  | { kind: 'reply'; seq: number; rttMs: number; dup: boolean }
  | { kind: 'timeout'; seq: number }
  | { kind: 'error'; reason: string } // stderr `ping: sendto: <reason>` (LOCAL_ERROR)
  | { kind: 'ignore' } // header / summary / blank lines
  | { kind: 'unknown'; line: string }; // counted in errs, never loss

export type SampleState = 'RECEIVED' | 'LATE' | 'LOST' | 'UNMEASURED';

/** One record per (generation, seq); see §4.2. */
export interface PingSample {
  gen: number; // stream generation (bumped on restart/retarget)
  seq: number; // icmp_seq within the generation
  state: SampleState;
  rttMs: number | null; // RECEIVED/LATE only
  at: number; // send time, monotonic ms (sendEpoch + seq × 1000)
  loaded: boolean; // §4.8 send time within a loaded second
  synthesized: boolean; // LOST/UNMEASURED created by the deadline backstop, not a ping line
}

/** Per-stream statistics for one window (§5). Percentiles nearest-rank; UNMEASURED excluded. */
export interface StreamStats {
  windowMs: number; // window used for p50/p95/p10/jitter/late/counts
  idleOnly: boolean; // true when computed from idle samples only (§4.8)
  p50: number | null; // RTT of RECEIVED + LATE
  p95: number | null;
  p10: number | null;
  jitter: number | null; // mean |Δ| consecutive received; null if < 3
  loss: number | null; // LOST / (RECEIVED+LATE+LOST) × 100 in this window; null if < 3 settled
  loss10: number | null; // fixed 10 s window regardless of windowMs
  loss60: number | null; // fixed 60 s window
  loss300: number | null; // fixed 300 s window
  received: number; // RECEIVED count in window
  late: number; // LATE count in window
  lost: number; // LOST count in window
  unmeasured: number; // UNMEASURED count in window
  settled: number; // received + late + lost
}

// §4.3 captive-portal check
export type HttpKind = 'ok' | 'portal' | 'fail' | 'dnsfail';
export type HttpDetector = 'apple' | 'google';

export interface HttpResult {
  kind: HttpKind;
  detector: HttpDetector;
  url: string; // detector URL that was fetched
  code: number | null; // %{http_code}; null when curl failed before a response
  exitCode: number | null; // curl exit code (6 dnsfail, 7 connect, 28 timeout, 35/60 TLS)
  startedAt: number; // monotonic ms when the request was launched
  ms: number | null; // time_total × 1000
  connectMs: number | null; // (time_connect − time_namelookup) × 1000 = one TCP RTT
  redirectUrl: string | null; // %{redirect_url} when portal (detector URL only for a Location-less 3xx/511)
}

// §4.4 HTTPS cross-check
export type HttpsKind = 'ok' | 'portal' | 'fail';

export interface HttpsResult {
  kind: HttpsKind;
  code: number | null;
  exitCode: number | null;
  startedAt: number; // monotonic ms
  ms: number | null; // time_total × 1000
}

// §4.5 DNS
export type DnsErr = 'TIMEOUT' | 'DNS_ERROR' | 'PROBE_ERROR';

/** Output of parseDig; the poller adds timing/context via DnsPair. */
export interface DnsResult {
  ok: boolean; // exit 0 && status NOERROR|NXDOMAIN
  ms: number | null; // `Query time: N msec` (never wall time)
  server: string | null; // `SERVER: <addr>#port`
  status: string | null; // NOERROR / NXDOMAIN / SERVFAIL / …
  err: DnsErr | null; // PROBE_ERROR is ignored for dnsOk and shown as `?`
}

/** One DNS round: system path + direct @1.1.1.1 for the same name. */
export interface DnsPair {
  name: string; // queried name (rotation or cache-buster)
  sys: DnsResult;
  direct: DnsResult;
  at: number; // monotonic ms when the round started
}

// §4.6 Wi-Fi radio (parseAirportJson output; poller stamps `at`)
export type WifiAssoc = 'yes' | 'no';
export type SnrLabel = 'good' | 'fair' | 'poor';

export interface WifiInfo {
  iface: string; // interface the block was selected by (_name === iface)
  assoc: WifiAssoc; // spairport_status_connected → 'yes'
  ssid: string | null; // null when '<redacted>' or absent
  rssi: number | null; // dBm
  noise: number | null; // dBm
  snr: number | null; // rssi − noise
  label: SnrLabel | null; // good ≥ 25, fair 15–24, poor < 15
  txRate: number | null; // Mbps
  mcs: number | null;
  channel: string | null; // e.g. "157 (5GHz, 80MHz)"
  phy: string | null; // e.g. "802.11ax"
}

// §4.7 interface byte counters
export interface CounterSample {
  iface: string;
  ibytes: number; // cumulative from netstat
  obytes: number;
  at: number; // monotonic ms
  inKBs: number | null; // rate vs previous sample (KB/s); null when skipped (§4.7)
  outKBs: number | null;
}

// §4.1 route / interface discovery
export interface RouteInfo {
  hasRoute: boolean; // `route -n get <target>` succeeded
  egressIface: string | null; // interface: from route get (utunN when VPN)
  wifiIface: string | null; // Hardware Port: Wi-Fi device, or --iface
  gateway: string | null; // gateway: from route get
  pingGateway: string | null; // dotted-quad gateway to ping (physical router when VPN), else null
  ipv4: string | null; // wifiIface address from scutil --nwi
  selfAssigned: boolean; // ipv4 starts with 169.254.
  vpn: boolean; // egressIface matches /^utun\d+/
  at: number; // monotonic ms of the probe
}

// §4.9 opt-in speed test (parseSpeedOut output; runSpeedTest/store stamp timing)
export interface SpeedResult {
  ok: boolean; // code 200 && size_download ≥ 200000
  downMbps: number | null; // speed_download × 8 / 1e6 when ok
  bytes: number; // size_download actually transferred (counted in the budget even on failure)
  ms: number | null; // time_total × 1000
  code: number | null; // http_code
  why: string | null; // short failure reason for the TRAFFIC cell, null when ok
}
