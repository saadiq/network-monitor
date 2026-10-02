# netmon — In-flight Wi-Fi monitor: final design spec

Date: 2026-09-06
Runtime: Bun 1.4 + TypeScript, zero npm dependencies. Platform: macOS 26 (Darwin 25.6), Apple Silicon, no sudo.

## 1. Basis of this spec

The three judges split 1-1-1 on an overall winner, but agreed unanimously that Design 0 answers the traveler's questions best (usefulness 9/9/9), that Design 1 has the most correct measurement core, and that Design 2 has the most robust chassis. This spec therefore takes Design 0's screen, state model and traveler-facing verdicts as the base, grafts Design 1's measurement engine (stream ping without `-W`, LATE/LOST/ERROR/PROBE_ERROR taxonomy, per-link hysteresis, ICMP-filtered latch, `-json` Wi-Fi parsing, `ipconfig getoption` for VPN, `dig +stats`), and Design 2's chassis (single never-throwing `run()`, absolute binary paths, preflight, parse-from-end `netstat`, WARMUP, `--plain` fallback, size polling, idempotent shutdown). Every item in the judges' cut lists is removed, and every error they found is fixed (see §14).

## 2. What the screen answers

Within one glance, top to bottom:

1. **Is it up?** — a colored state word (UP / DEGRADED / DOWN / PORTAL / NO LINK / WARMUP), a grade letter, and one plain-English sentence.
2. **What can I do?** — CHAT / BROWSE / VIDEO CALL / DOWNLOAD, each OK / SHAKY / NO with the single binding reason (≤ 28 chars).
3. **Is it me or the plane?** — a hop path Wi-Fi → Router → Internet → DNS → Web with the first failing hop marked.
4. **How long do drops last here? Is it getting better?** — a 15-minute timeline bar, a drops table with median/longest/since-last, and a trend phrase.
5. **Did the portal log me out?** — a PORTAL state, `o` to open the login page, bell on transitions.

The default **simple view** answers 1–4 with a state badge, activity chips, a hop chain, a latency chart and the timeline; the dense screen in §8.1/§8.2 is the **advanced view** (key `v`, flag `--advanced`). See `2026-10-02-simple-view-design.md`.

## 3. Runtime layout and constants

All constants live in `src/config.ts`. Values used throughout this document:

| Constant | Value | Purpose |
|---|---|---|
| `TICK_MS` | 1000 | Main loop / render cadence |
| `PING_PAYLOAD_BYTES` | 16 | `ping -s 16` (44 B per packet at IP layer, still prints `time=`) |
| `SETTLE_DEADLINE_MS` | 2000 | A seq with no line 2 s after its send time is synthesized LOST |
| `STREAM_STALL_MS` / `STREAM_RESTART_MS` | 3000 / 5000 | No output for 3 s → seconds are UNMEASURED; 5 s → restart |
| `STREAM_BACKOFF_MS` | 1000, 2000, 5000 (cap) | Restart backoff |
| `LINK_DOWN_LOST` / `LINK_UP_RECEIVED` | 3 / 2 | Per-stream link hysteresis |
| `HTTP_CADENCE_MS` / `HTTP_FAST_CADENCE_MS` | 10000 / 3000 | Captive check; fast while not UP or while confirming |
| `HTTP_TIMEOUT_S` / `HTTP_STALE_MS` | 4 / 30000 | `curl -m 4`; result ignored after 30 s |
| `HTTPS_CADENCE_MS` | 180000 | TLS cross-check |
| `DNS_CADENCE_MS` | 15000 | dig direct + system |
| `ROUTE_CADENCE_MS` / `ROUTE_FAST_CADENCE_MS` | 5000 / 2000 | Fast while NO_LINK or gateway link down |
| `WIFI_CADENCE_MS` / `WIFI_KILL_MS` / `WIFI_BACKOFF_MS` | 60000 / 40000 / 120000 | system_profiler (≈13 s wall isolated, ≈24 s under contention, so the kill is ≈3x the good case) |
| `WIFI_STALE_MS` | 150000 | Show `—` after this |
| `COUNTERS_CADENCE_MS` | 1000 | netstat |
| `WIN_FAST_MS` / `WIN_MAIN_MS` / `WIN_TREND_MS` / `WIN_CAP_MS` / `WIN_HISTORY_MS` | 10000 / 60000 / 120000 / 300000 / 900000 | loss10 · grade & verdicts · trend halves · loss cap · timeline & drops |
| `ICMP_BLOCKED_AFTER_MS` | 30000 | inet stream down ≥ 30 s with ≥ 2 consecutive HTTP ok → latch |
| `SAT_P10_MS` / `SAT_CLEAR_MS` / `SAT_LOSS_MAX` | 400 / 300 / 2 | Satellite mode enter/exit |
| `GRADE_HOLD_TICKS` | 5 | Raw grade must be stable 5 ticks before displayed grade changes |
| `SPEED_BYTES` / `SPEED_MIN_GAP_MS` / `SPEED_VALID_MS` | 250000 / 30000 / 600000 | Opt-in test |
| `BELL_MIN_GAP_MS` | 5000 | Rate limit |
| `GAP_MS` | 5000 | Tick gap ≥ 5 s = sleep |
| `MIN_COLS` / `MIN_ROWS` | 72 / 18 | Below this, "terminal too small" |
| `FULL_COLS` / `FULL_ROWS` | 100 / 27 | Full layout |
| `LOADED_KBS` | 500 | Passive in+out above this tags ping samples `loaded` |

Binaries (absolute, checked at preflight): `/sbin/ping`, `/usr/bin/dig`, `/usr/bin/curl`, `/usr/sbin/netstat`, `/sbin/route`, `/usr/sbin/scutil`, `/usr/sbin/networksetup`, `/usr/sbin/ipconfig`, `/usr/sbin/system_profiler`, `/usr/bin/open`. A missing binary disables that probe (its UI cell shows `dig: missing`), never crashes. The label is the tool name, shortened where the full name would fill a whole metric cell and touch its neighbour — `system_profiler` shows as `profiler: missing` (§8.1).

## 4. Probes: exact commands and parsing

All one-shot commands go through `run(argv, timeoutMs)` (§9, `src/core/proc.ts`), which never throws. The two ping streams go through `streamLines`.

### 4.1 Route / interface discovery (`src/probes/route.ts`)

Cadence 5 s (2 s while state is NO_LINK or gateway link is down). All timeouts 3 s.

1. `/sbin/route -n get <target>` (target default `1.1.1.1`, the address probes actually traverse — not `default`, because Tailscale-style VPNs add a second `default ... utunN` route without changing `route -n get default`).
   Parse `/^\s*gateway:\s*(\S+)/m` → `gateway`, `/^\s*interface:\s*(\S+)/m` → `egressIface`. Exit ≠ 0 or output containing `not in table` → `hasRoute=false`.
2. `/usr/sbin/networksetup -listallhardwareports` at startup and whenever `egressIface` changes (5 s timeout). Parse consecutive lines `Hardware Port: Wi-Fi` / `Device: (\S+)` → `wifiIface`. `--iface` overrides.
3. `/usr/sbin/scutil --nwi`. Inside the block starting `IPv4 network interface information`, find the line `^\s+<wifiIface> : flags` and the next `address\s*:\s*(\S+)` → `ipv4`. `selfAssigned = ipv4.startsWith('169.254.')`.
4. If `egressIface` matches `/^utun\d+/`: `vpn=true`; physical gateway = stdout of `/usr/sbin/ipconfig getoption <wifiIface> router` if it matches `/^\d+\.\d+\.\d+\.\d+$/`, else `null`. Otherwise `pingGateway = gateway` if dotted-quad, else `null` (gateway link `unknown`, Router hop hidden).
5. `countersIface = vpn ? wifiIface : egressIface`. Wi-Fi polling runs when `wifiIface` is known and either there is no route at all, or `egressIface === wifiIface`, or `vpn`; equivalently it pauses only while `hasRoute && egressIface !== wifiIface && !vpn` (a live non-Wi-Fi egress, e.g. Ethernet). The no-route case is load-bearing: §6.2 row 1 needs `assoc` precisely when there is no route, to tell `not-joined` from `no-dhcp`.

Emits `RouteInfo { hasRoute, egressIface, wifiIface, gateway, pingGateway, ipv4, selfAssigned, vpn, at }`. A change of `pingGateway` retargets the gateway ping stream. Route loss is definitive (no debounce).

### 4.2 Ping streams (`src/probes/ping-parse.ts`, `src/probes/ping-stream.ts`)

Two long-lived processes, stdout **and stderr** piped: `/sbin/ping -n -i 1 -s 16 <host>` for the gateway and for the target. No `-W`: with `-i 1` the `Request timeout` line prints at the next send regardless of `-W`, and `-W` would suppress replies slower than its value (fatal on 600–900 ms GEO links).

`parsePingLine(line): PingEvent`:

| Regex | Event |
|---|---|
| `/^(\d+) bytes from ([\d.]+): icmp_seq=(\d+) ttl=(\d+) time=([\d.]+) ms( \(DUP!\))?$/` | `{kind:'reply', seq, rttMs, dup}` |
| `/^Request timeout for icmp_seq (\d+)$/` | `{kind:'timeout', seq}` |
| `/^ping: sendto: (.+)$/` (stderr) | `{kind:'error', reason}` (LOCAL_ERROR: "No route to host", "Network is unreachable", "Host is down") |
| `/^PING /`, `/^--- .* ---$/`, `/^\d+ packets transmitted/`, `/^round-trip/`, blank | `{kind:'ignore'}` |
| anything else | `{kind:'unknown', line}` → counted in `errs`, logged, not loss |

Per-stream sample window (`src/model/samples.ts`), keyed by `(generation, seq)`:

- `sendEpoch` = spawn monotonic time + 20 ms, refined on every non-dup reply by EWMA (α 0.1) of `arrival − rtt − seq×1000`. `sendTime(seq) = sendEpoch + seq×1000`.
- `reply` → if record is LOST → state **LATE** (rtt kept); if none → **RECEIVED**; if RECEIVED already (dup) → ignore.
- `timeout` → record **LOST** unless RECEIVED/LATE.
- `error` → sets `localErrorAt = now` (flips the link state DOWN immediately, §6.1); no sample is created for it (the timeout line for that seq follows and creates the LOST record — creating both would double-count).
- Each tick: any seq ≤ `maxSeqSeen + floor((now − sendTime(maxSeqSeen))/1000)` whose `sendTime + 2000 < now` and has no record becomes **LOST** with `synthesized=true` — unless the stream is stalled (no line of any kind for ≥ 3 s), in which case it becomes **UNMEASURED**. This backstop is required because macOS ping prints `Request timeout` only when cumulative missing packets exceed the previous maximum, so after LATE replies some later losses print no line at all.
- Samples carry `loaded: boolean` (§4.8) and `at` (send time).
- Stall ≥ 5 s or process exit → kill, restart with backoff (1, 2, 5 s), `generation++`, seq restarts at 0; pending seqs of the old generation become UNMEASURED. UNMEASURED never counts as loss and never opens an outage.
- `retarget(host)` kills and restarts immediately with generation bump.

### 4.3 Captive-portal HTTP check (`src/probes/http.ts`)

Alternates two detectors (so a portal that whitelists one is still caught):

```
/usr/bin/curl -4 -s -m 4 -A netmon/1 -o - \
  -w '\n@@|%{http_code}|%{redirect_url}|%{time_namelookup}|%{time_connect}|%{time_total}|%{size_download}' \
  http://captive.apple.com/hotspot-detect.html
/usr/bin/curl ... http://connectivitycheck.gstatic.com/generate_204
```

Process timeout 6 s. Never `-L`. Split stdout on the last `\n@@|` → `body`, then split the tail on `|` (a `|` separator, because `%{redirect_url}` is empty on success and a space-separated format shifts fields).

`classifyCaptive(exitCode, detector, code, body, redirectUrl, sizeDownload): HttpKind`:

| Condition (in order) | Kind |
|---|---|
| exit 6 (could not resolve) | `dnsfail` |
| exit ≠ 0 (7 connect, 28 timeout, 35/60 TLS, others) | `fail` |
| code 3xx (any) or code 511 | `portal` (keep `redirectUrl`, or `Location`-less → keep detector URL) |
| apple: code 200 and body contains `Success` | `ok` |
| apple: code 200 without `Success` | `portal` |
| google: code 204 and `size_download == 0` | `ok` |
| google: code 200 | `portal` |
| anything else (4xx, 5xx) | `fail` |

Result: `HttpResult { kind, detector, code, startedAt, ms: time_total×1000, connectMs: (time_connect − time_namelookup)×1000, redirectUrl }`. Single-flight. Cadence 10 s while confirmed state is UP/DEGRADED and no confirmation is pending; 3 s while state ∈ {DOWN, PORTAL, NO_LINK} or while `inetLink === 'down'` and the ICMP-blocked latch is not set. An out-of-band check is fired immediately when `inetLink` flips to `down` (confirmation, §6.2). `webFailStreak` = consecutive `fail` results.

Portal signal (§6.1) needs two portal results; it clears only after two consecutive `ok` results (one from each detector) or one HTTPS `ok`, so a portal that whitelists Apple's detector cannot make the state flap.

### 4.4 HTTPS cross-check (`src/probes/https.ts`)

```
/usr/bin/curl -4 -s -m 6 -A netmon/1 -o - \
  -w '\n@@|%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_total}' \
  https://www.cloudflare.com/cdn-cgi/trace
```

Process timeout 8 s. Every 180 s, plus immediately (max once per 60 s) when: the state leaves PORTAL/DOWN, or the captive check says `ok` while `inetLink === 'down'` and both DNS resolvers fail. Classification: exit 0 and code 200 and body matches `/^ip=/m` → `ok`; exit 35 or 60 (TLS intercepted) or code 3xx → `portal`; otherwise `fail`. Body is ~214 B; the handshake makes each probe ~5 KB, hence the slow cadence. Only `ok`/`portal` are used (portal evidence and PORTAL exit); egress IP/colo are not displayed.

### 4.5 DNS (`src/probes/dns.ts`)

Every 15 s, two concurrent runs (process timeout 4 s each, `Promise.allSettled`):

```
/usr/bin/dig +time=2 +tries=1 +noall +comments +stats <name> A
/usr/bin/dig +time=2 +tries=1 +noall +comments +stats <name> A @1.1.1.1
```

`<name>` rotates `www.apple.com`, `www.cloudflare.com`, `www.google.com`; every 4th round uses `<8 hex>.example.com` (cache-buster: an NXDOMAIN proves recursion works instead of a resolver cache).

`parseDig(stdout, exitCode): DnsResult`: `ok = exit 0 && /status: (NOERROR|NXDOMAIN)/`; `ms` from `/Query time: (\d+) msec/` (never wall time — that includes spawn cost); `server` from `/SERVER: ([\d.:a-f]+)#/`; `status` string; exit 9 or `connection timed out` → `ok=false, err:'TIMEOUT'`; SERVFAIL/REFUSED → `ok=false, err:'DNS_ERROR'`; spawn failure → `err:'PROBE_ERROR'` (ignored for dnsOk, shown as `?`). The system-path `server` populates the header (`dns 100.100.100.100 (ts)` when it is `100.100.100.100`).

### 4.6 Wi-Fi radio (`src/probes/wifi.ts`)

`/usr/sbin/system_profiler -nospawn -json SPAirPortDataType -detailLevel basic`, every 60 s, killed at 40 s, single-flight; after 3 consecutive failures cadence becomes 120 s. Runs when `wifiIface` is known and either there is no route at all, or `wifiIface` is the egress, or a VPN is active (§4.1.5).

`-nospawn` is load-bearing, not a tidiness flag: without it `system_profiler` forks a `-nospawn -xml … -detailLevel full` helper of its own. That grandchild is not in our process tree by the time we would need it, so `WIFI_KILL_MS` cannot reach it and it outlives the run — on SIGINT it is reparented to launchd and survives as an orphan. With `-nospawn` the reader runs in the one process we spawned and killing that is enough.

`parseAirportJson(json, iface): WifiInfo | null`:

```
const ifc = JSON.parse(json).SPAirPortDataType?.[0]?.spairport_airport_interfaces?.find(i => i._name === iface)
assoc = ifc.spairport_status_information === 'spairport_status_connected' ? 'yes' : 'no'
cni = ifc.spairport_current_network_information       // may be absent → assoc 'no'
[rssi, noise] = /(-?\d+) dBm \/ (-?\d+) dBm/.exec(cni.spairport_signal_noise)
txRate = Number(cni.spairport_network_rate); mcs = Number(cni.spairport_network_mcs)
channel = cni.spairport_network_channel; phy = cni.spairport_network_phymode
ssid = cni._name === '<redacted>' ? null : cni._name
```

Selecting by `_name === iface` is mandatory: `awdl0` also carries a `spairport_current_network_information` block (without signal fields). `snr = rssi − noise`; label `good ≥ 25`, `fair 15–24`, `poor < 15`. Sample age is shown; `—` after 150 s. Until the first result the column reads `reading…`.

### 4.7 Interface byte counters (`src/probes/counters.ts`)

`/usr/sbin/netstat -ib -I <countersIface>` every second, timeout 2 s. `parseNetstat(stdout, iface)`: pick the line whose first token equals `iface` and whose **third** token (the Network column) starts with `<Link#`; split on whitespace; `obytes = Number(tokens[tokens.length − 2])`, `ibytes = Number(tokens[tokens.length − 5])`. Parsing from the end is required because `<Link#>` rows for `utun*`/`lo0` have no Address token (10 fields instead of 11). Rates: `Δbytes / Δt` (monotonic); negative Δ (counter reset, interface change) or Δt > 5 s → sample skipped; session totals = sum of positive deltas; interface change keeps totals.

### 4.8 Loaded tagging

A ping sample is `loaded` when its send time is within ±2 s of a speed test, or the passive in+out rate in that second exceeds 500 KB/s. Grade and verdicts use only idle samples when the 60 s window holds ≥ 10 idle received samples; otherwise they use all samples and the grade is suffixed `~` (under load).

### 4.9 Opt-in speed test (`src/probes/speed.ts`)

Keypress `t` only (no flag, no timer):

```
/usr/bin/curl -4 -s -m 20 -o /dev/null \
  -w '%{http_code}|%{size_download}|%{time_total}|%{speed_download}|%{time_starttransfer}' \
  'https://speed.cloudflare.com/__down?bytes=250000'
```

Process timeout 22 s. When code 200 and `size_download ≥ 200000`, `downMbps` is the **transfer phase** — `size_download / (time_total − time_starttransfer) × 8 / 1e6` — whenever `time_starttransfer > 0` and that phase exceeds 10 ms, falling back to `speed_download × 8 / 1e6` otherwise; anything else is `failed`. curl's own `speed_download` is `size / time_total`, which charges DNS, connect and TTFB to the download and understates a short burst by 3–4x on a high-latency link. It is still only a small-burst estimate and is labelled as one. Refused with a footer message while the first verdict has not landed (WARMUP: "wait for the first verdict"), when state ∉ {UP, DEGRADED} ("no point testing while down"), or within 30 s of the previous run. Result valid for verdicts for 10 min; shown with age. Bytes added to the probe budget. Download only — no upload probe.

### 4.10 Probe data budget (`src/model/budget.ts`)

Estimated bytes per sample, both directions, IP layer: ping 88 B; dig 300 B per pair; captive 1000 B; HTTPS 5000 B; speed test `size_download + 2000`. Baseline ≈ 0.63 (2 pings/s) + 0.07 (DNS) + 0.36 (captive at 10 s) + 0.10 (HTTPS) ≈ **1.2 MB/h** (≈ 1.6 MB/h with 802.11 framing). The footer shows the session total and this hourly estimate; there is no pause key because sampling is the point.

## 5. Metrics

All windows are time-based over sample send times, evicted at 900 s. Percentiles are nearest-rank over sorted values. UNMEASURED samples are excluded everywhere.

| Metric | Definition | Window |
|---|---|---|
| `gw.p50/p95`, `inet.p50/p95` | RTT of RECEIVED + LATE samples (LATE included so a slow link shows honest tail latency instead of loss) | 60 s |
| `inet.p10_120` | 10th percentile of inet RTT | 120 s (satellite detection) |
| `jitter` | mean |rtt_i − rtt_{i−1}| over consecutive received samples (RFC 3550 spirit, losses do not break pairs); null if < 3 | 60 s |
| `loss10`, `loss60`, `loss300` per stream | LOST / (RECEIVED + LATE + LOST) × 100; null if < 3 settled samples | 10 / 60 / 300 s |
| `late60` | count of LATE samples (shown as "late 3") | 60 s |
| `blips` | LOST runs of length 1–2 on the inet stream that did not become an outage | 60 s |
| `unmeasured60`, `errs` | UNMEASURED seconds; count of PROBE_ERROR / unknown lines | 60 s / session |
| `http` | last captive result: kind, code, ms, connectMs, age | latest; stale after 30 s |
| `rttProxyMs` | `http.connectMs` (one TCP RTT) — used only when `icmpBlocked` | latest |
| `dnsDirect`, `dnsSys` | last result each: ok, ms, server, age; `dnsDirectOk`/`dnsSysOk` = a success within 45 s; `dnsOk = either` | 45 s |
| `wifi` | rssi, noise, snr, label, txRate, mcs, channel, phy, assoc, age | latest |
| `inKBs`, `outKBs`, `sessionIn/Out` | counter deltas; 1 s value + 10-sample sparkline | 1 s / 10 s / session |
| `idleP50`, `loadedP50` | p50 split by `loaded` tag (used for the `~` marker only) | 60 s |
| `state`, `cause`, `since` | confirmed state, cause, transition time | per tick |
| `grade` | held grade A–D (§7) | 60 s inputs, 5-tick hold |
| `sat`, `rttOffset` | satellite mode and threshold offset (§7.1) | 120 s |
| `steadyFor` | seconds since last confirmed transition into UP/DEGRADED (or start) | session |
| `downFor` | seconds since the open outage's backdated start | current |
| `drops15`, `drops60`, `dropsSession` | closed outages whose start is in the window (sleep-closed outages excluded) | 15 m / 1 h / session |
| `dropMedianS`, `dropLongestS`, `dropUnder30` | over closed outages | session |
| `dropGapS` | mean seconds from one outage's end to the next start (≥ 2 drops) | session |
| `sinceLastDrop` | seconds since the last outage ended; null if none | session |
| `uptime15`, `uptime60` | 1 − down / measured × 100, down = seconds in {DOWN, PORTAL, NO_LINK}, measured = seconds not WARMUP and not in a sleep gap | 15 m / 1 h |
| `trend` | latency and loss, last 60 s vs prior 60 s (§7.3) | 120 s |
| `speed` | last test: downMbps, age, bytes | 10 min validity |
| `probeBytes`, `probeRateEst` | §4.10 | session |

## 6. State machine (`src/model/signals.ts`, `src/model/status.ts`)

### 6.1 Per-stream link state (pure, `samples.ts`)

For each stream, walk settled samples in seq order:

- `localErrorAt` within the last 3 s → `down` immediately.
- last 3 settled samples all LOST → `down`
- last 2 settled samples RECEIVED/LATE → `up`
- fewer than 2 settled → `unknown`; otherwise keep previous.

Recomputed every tick from the ring, so a LATE flip retroactively repairs a lost run. `inetDownSince` = send time of the first LOST in the run that produced `down`.

Portal signal: `portalSignal = true` when the last captive/HTTPS result is `portal` and (it has a non-empty `redirectUrl` or code 511, or at least one of the two previous results was `portal`). It becomes `false` only after two consecutive `ok` captive results (one per detector) or one HTTPS `ok`.

ICMP-blocked latch: set when `inetLink === 'down'` for ≥ 30 s and the last 2 captive results are `ok`; cleared by any inet RECEIVED/LATE sample. While set: Internet hop shows `✔ http 120ms`, latency source = `rttProxyMs`, jitter/loss come from the gateway stream (labelled `(router)`), grade capped at B, captive cadence returns to 10 s.

Gateway no-ICMP: `gwNoIcmp = gwLink === 'down' && inetOk`, but it is only *carried forward* through a later internet drop once the condition has held `GW_NO_ICMP_HOLD_MS` (5 s). A single tick in which the gateway stream flips down just before the internet one is two ping phases coinciding, not a router that ignores ICMP; without the hold a simultaneous Wi-Fi/router loss would be misread as DOWN(uplink). Once held, the latch survives a later uplink drop. The Router hop shows `– no icmp`, the gateway stream is excluded from the state machine, and the local-link cause is never attributed from it.

### 6.2 Signals → candidate (first match wins; total)

```
inetOk =
  inetLink === 'up'
  || (icmpBlocked && http && http.kind !== 'fail' && http.age ≤ 30 s)
  || (http && http.kind === 'ok' && http.age ≤ 30 s && http.startedAt ≥ inetDownSince)
```

An HTTP success that predates the ICMP failure is not evidence the internet is up now. Confirmation grace: for up to 5 s after `inetLink` flips to `down`, while the out-of-band captive check is in flight and the previous captive result was `ok` ≤ 10 s old, the candidate is held at the previous confirmed state (this avoids a 2–4 s false DOWN on ICMP-filtered networks).

| # | Candidate | Condition |
|---|---|---|
| 1 | `NO_LINK` cause `not-joined` / `no-dhcp` / `unknown` | `!hasRoute`; cause `no-dhcp` if `assoc==='yes'` or `selfAssigned`, `not-joined` if `assoc==='no'`, else `unknown` |
| 2 | `PORTAL` cause `portal` | `portalSignal` |
| 3 | `WARMUP` | `inetLink === 'unknown'` and no captive result yet |
| 4 | `DOWN` cause `wifi` | `!inetOk && gwLink==='down' && (assoc==='no' || (rssi != null && rssi < −85))` |
| 5 | `DOWN` cause `router` | `!inetOk && gwLink==='down'` |
| 6 | `DOWN` cause `uplink` | `!inetOk` (gateway up, unknown or no-icmp) |
| 7 | `DEGRADED` cause `dns` | `!dnsSysOk && !dnsDirectOk` (or last captive kind `dnsfail` with `!dnsSysOk`) |
| 8 | `DEGRADED` cause `web` | `webFailStreak ≥ 3` while `inetLink==='up'` |
| 9 | `DEGRADED` cause `quality` | held grade ∈ {C, D} |
| 10 | `UP` | otherwise |

### 6.3 Debounce and transitions

A candidate becomes the confirmed state after N consecutive ticks: NO_LINK 1, PORTAL 1, WARMUP 1, DOWN 2, DEGRADED 1 (the 5-tick grade hold already smooths it), UP 2. Outage timestamps are backdated: start = `inetDownSince` (or `gwDownSince` for router/wifi, the first portal result's `startedAt`, or the failing route probe's time); end = send time of the first RECEIVED sample of the recovery run (or the successful captive result's `startedAt`, or the route probe time). Cause is fixed at open, except DOWN(uplink) → PORTAL rewrites the cause to `portal` (portals appear once the uplink returns). Typical timing: first lost packet → confirmed DOWN in 4–5 s; reconnection → confirmed UP in 2–4 s.

Sleep: a tick gap ≥ 5 s closes any open outage at the gap start with `sleep=true` (excluded from drop stats), marks the gap UNMEASURED, restarts both streams, and the state passes through WARMUP.

## 7. Grade and verdicts

### 7.1 Satellite mode (`src/model/satellite.ts`)

After ≥ 120 s of inet data: `sat = true` when `inet.p10_120 ≥ 400 ms && loss120 ≤ 2 %`; `sat = false` when `p10_120 < 300 ms`. While on, `rttOffset = round50(max(0, p10_120 − 100))`, recomputed every 60 s. Grade and all activity RTT comparisons use `R = p50 − rttOffset` and `P95 = p95 − rttOffset`; loss and jitter thresholds are unchanged. Header shows `sat +600ms`; reasons show absolute numbers.

### 7.2 Grade (`src/model/grade.ts`)

Inputs (60 s, idle samples preferred, §4.8): `L`, `R`, `P95`, `J = jitter`. When `icmpBlocked`: `R = rttProxyMs`, `P95` not applied, `L`/`J` from the gateway stream.

`L` is **not** the metric row's `loss60`. It is `lossGrade`: loss over the *current steady run* — the 60 s window clamped to `drops.sinceLastDrop`, so a closed outage's own LOST samples stay visible in the metrics but stop holding the grade (and with it the verdicts) at C/D once the link is clean again. The outage is already priced in by the recent-drop and FLAKY caps. Two minimums guard a young run, where one lost packet is a large fraction of the window: below `GRADE_MIN_SETTLED_FOR_LOSS` (10) settled samples loss is not applied at all, and below `GRADE_LOSS_TIER_SETTLED` (20) it is capped at `GRADE_SHORT_RUN_LOSS_CAP` (tier B's own loss limit), so it may cost the A grade but can never drag the grade below B. Without this, a single ARP-time loss in the first minute read as C → DEGRADED(quality) on a healthy link.

| Grade | Rule |
|---|---|
| A GOOD | `L ≤ 1 && R ≤ 150 && P95 ≤ 300 && J ≤ 30` |
| B OK | `L ≤ 5 && R ≤ 300 && P95 ≤ 600 && J ≤ 60` |
| C POOR | `L ≤ 15 && R ≤ 800 && P95 ≤ 1500 && J ≤ 150` |
| D BAD | otherwise |

Caps after tiering: outage ended < 120 s ago → max B; `drops15 ≥ 3` → max B and tag `FLAKY`; `loss300 > 10 %` → max C; `icmpBlocked` → max B; under load (`~`). Hold: the displayed grade changes only when the raw grade has been identical for 5 consecutive ticks; entering/leaving a non-graded state resets the hold. Colors: A/B green, C yellow, D red.

### 7.3 Trend (`src/model/trend.ts`)

Last 60 s vs prior 60 s (requires ≥ 10 received samples in each half). Latency `worse` if `p50_last ≥ 1.25 × p50_prior && ≥ +20 ms`, `better` if `≤ 0.8 ×` and ≥ 20 ms lower. Loss `worse` if +3 points, `better` if −3. Banner phrase `getting worse ▲` when any is worse and none better; `improving ▼` when any is better and none worse; otherwise none. Arrows next to the metric cells. No RSSI trend (two profiler readings differ by ±3 dBm on noise).

### 7.4 Activity verdicts (`src/model/verdicts.ts`)

`offline = state ∈ {DOWN, PORTAL, NO_LINK}`; `W = WARMUP`. Reasons are the first failing rule's text, ≤ 28 chars. `sinceDrop` is ∞ when there are no drops.

**CHAT** (messaging, email, small git pushes)
- `?` if W · NO if offline (`offline` / `portal login`)
- SHAKY if `L > 15` (`loss 18%`) or `R > 1500` (`slow 1.8s`) or `sinceDrop < 30` (`just came back`)
- else OK

**BROWSE**
- `?` if W · NO if offline, or `!dnsOk` (`DNS failing`)
- SHAKY if grade D (`grade D`) or `L > 8` (`loss 12%`) or `R > 600` (`slow 0.8s`) or `http.ms > 2000` (`pages 2.4s`) or `dnsSys.ms > 500` (`DNS 580ms`) or `sinceDrop < 30` (`just came back`)
- else OK

**VIDEO CALL**
- `?` if W
- OK if `state === UP && grade ∈ {A,B} && L ≤ 3 && J ≤ 50 && R ≤ 250 && sinceDrop ≥ 300 && drops15 ≤ 1 && (speed absent || speed.down ≥ 1.5)`
- SHAKY if `state ∈ {UP, DEGRADED} && L ≤ 8 && J ≤ 100 && R ≤ 400 && sinceDrop ≥ 60`; reason = first failed OK rule (`jitter 71ms`, `drop 4m ago`, `3 drops/15m`, `down 1.1 Mbps`, `grade C`), with ` · audio ok` appended when `L ≤ 5 && J ≤ 60`
- else NO (`loss 12%`, `drop 40s ago`, `jitter 140ms`, `offline`)

**DOWNLOAD** (large, > 100 MB)
- `?` if W
- OK if `state === UP && grade ∈ {A,B,C} && uptime15 ≥ 97 && sinceDrop ≥ 300 && (speed absent || speed.down ≥ 8)`; reason `untested (t)` when speed absent, else `↓22 Mbps`
- SHAKY if `state ∈ {UP, DEGRADED} && uptime15 ≥ 85 && drops15 ≤ 2`; reason `use curl -C - (resumable)` / `drop 4m ago` / `down 2.1 Mbps`
- else NO (`3 drops/15m`, `uptime 71%`, `offline`)

### 7.5 Banner text (`src/model/banner-text.ts`)

Line 1: `● STATE · <grade word> (<grade>)` · `steady 4m12s` (UP/DEGRADED) or `DOWN 0:42` / `PORTAL 1:05` / `NO LINK 0:12` (ticking) · trend phrase · `N drops in 15m` if N > 0 · `FLAKY` · `sat +600ms` · `~ under load`.

Line 2 (chosen by state/cause/grade, then truncated to width):

| Key | Sentence |
|---|---|
| WARMUP | `Measuring… first verdict in a few seconds.` |
| UP/A | `Good connection. Calls, browsing and downloads should all work.` |
| UP/B, DEGRADED/quality C, D | `Fine for chat & browsing.` + ` Video call <shaky/no> (<reason>).` if VIDEO ≠ OK + ` Big downloads: <shaky/no> (<reason>).` if DOWNLOAD ≠ OK. C: `Struggling (<binding reason>). Chat works; pages will crawl. Skip calls.` D: `Barely there (<binding reason>). Only messaging is realistic right now.` |
| DEGRADED/dns | `Pings work but names don't resolve — browsing is broken.` + tip suffix when only system DNS fails: ` Direct DNS works: likely Tailscale, not the plane.` |
| DEGRADED/web | `Pings work but web requests fail (3 in a row) — a portal or proxy may be interfering.` |
| DOWN/uplink | `Plane's uplink dropped — router fine, it's not you. <expectation>` |
| DOWN/router | `Can't reach the plane's router (signal <rssi> dBm). Move the laptop or re-join Wi-Fi. <expectation>` |
| DOWN/wifi | `Wi-Fi link weak or lost (signal <rssi> dBm). Move the laptop or re-join the network. <expectation>` |
| PORTAL | `Logged out of the airline portal. Press o to open the login page. <expectation>` |
| NO_LINK/not-joined | `Not joined to any Wi-Fi network. Join the airline Wi-Fi from the menu bar.` |
| NO_LINK/no-dhcp | `Joined Wi-Fi but got no address from the router (DHCP). Usually clears in ~30s; otherwise re-join.` |
| NO_LINK/unknown | `No network route. Check Wi-Fi in the menu bar.` |

`<expectation>`: `Drops here usually last ~22s (longest 1m04s).` when ≥ 2 drops; `First drop this session.` when none; `Longer than any drop so far.` once `downFor > dropLongestS` with ≥ 1 drop.

### 7.6 Tips (`src/model/tips.ts`)

Highest applicable, one line: PORTAL (`press o to open the login page`) > NO_LINK no-dhcp > weak signal `rssi < −80` (`weak signal -84 dBm — move the laptop; it may just be the seat`) > `icmpBlocked` (`airline blocks ping — judging by HTTP checks, latency is coarse`) > `gwNoIcmp` (`router ignores ping — local link judged by internet checks`) > Tailscale DNS slow `dnsSys.ms / dnsDirect.ms ≥ 4 && dnsSys.ms > 200` (`Tailscale DNS is 12x slower than direct (380 vs 31ms) — pages feel slow; consider pausing it.`) > system DNS failing while direct ok (`system DNS (Tailscale 100.100.100.100) failing; direct DNS works — Tailscale, not the plane`) > `vpn` (`traffic exits via utun9 (Tailscale exit node) — measurements go through the tunnel`) > ≥ 2 portal outages in 30 min (`portal logs you out every ~Nm — keep the login tab open`) > `sat` (`satellite link: ~700ms is normal here; thresholds adjusted`) > under load (`your own traffic is loading the link — numbers marked ~`) > none (row blank).

## 8. UI

### 8.1 Full layout (≥ 100 cols, ≥ 27 rows) — mockup at 100×30

```
 netmon  en1 · gw 192.168.0.1 · dns 100.100.100.100 (ts) · probes 0.4 MB        14:32:07  run 18m44s
────────────────────────────────────────────────────────────────────────────────────────────────────
  ● UP · OK (B)      steady 4m12s      getting worse ▲      3 drops in 15m
  Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no (3 drops/15m).
────────────────────────────────────────────────────────────────────────────────────────────────────
  CHAT ✔ OK    BROWSE ✔ OK    VIDEO ~ SHAKY jitter 71ms · audio ok    DOWNLOAD ✘ NO 3 drops/15m
────────────────────────────────────────────────────────────────────────────────────────────────────
  PATH  Wi-Fi ✔ -72dBm → Router ✔ 7ms → Internet ✔ 48ms → DNS ✔ 31ms (sys 380) → Web ✔ 200 OK
────────────────────────────────────────────────────────────────────────────────────────────────────
  LATENCY (60s) p50   p95 LOSS          10s   60s WI-FI (28s ago)         TRAFFIC (passive)
  router          7    11 router         0%    0% signal -72 dBm   snr 23 in    42 KB/s ▃▄▇▄▂▂▃▅▆█
  internet       48    86 internet       0%    2% noise  -95 dBm   fair   out    6 KB/s ▅▆█▆▅▅▆▇██
  jitter        71 ms ▲   5m 4%   blips 1 (60s)   tx 216 Mbps  MCS 4      session 38.2 MB↓ 4.1 MB↑
  http     0.31 s (200)   late 0  unmeasured 0    802.11ax ch157 5GHz/80  test 12m ago: ↓2.8 MB/s
  RTT 60s ▁▁▂▁▁▂▃▂▁▁▂▂▁▂▃▄▃▂▁▁▂▂▃▂▂▁▁▂▃▄▅▃▂▂▁▁▂▂▁▁▂▂▃▂▁▁▂▃▅▆▄▃▂▂▁▁▂▂▁▂  8–210ms  x = lost
────────────────────────────────────────────────────────────────────────────────────────────────────
 LAST 15m ██████████░░░████████████████▒▒▒▒▒▒███████████████████░░░░░████████████████████████████
          -15m     ▲14:19 wifi       ▲14:21 portal          ▲14:27 uplink                     now
────────────────────────────────────────────────────────────────────────────────────────────────────
  DROPS  #  started   lasted  cause                  3 drops/15m · median 22s · longest 1m04s
         3  14:27:55  22s     uplink (router fine)   last ended 4m12s ago · uptime 15m 91%
         2  14:21:10  1m04s   portal login needed    usually ~22s; 2 of 3 under 30s
         1  14:19:02  9s      wi-fi link lost        gap between drops ~4m
────────────────────────────────────────────────────────────────────────────────────────────────────
  TIP  Tailscale DNS is 12x slower than direct (380 vs 31ms) — pages feel slow; consider pausing it.


  q quit   t speed test (250 KB)   b bell:on   o open portal                     probes ~1.2 MB/h
```

The metric columns are four 24-character cells starting at column 3, padded to 24 visible characters so columns align at 3, 27, 51, 75. Content in the first three columns is capped at **23** visible cells, so a blank gutter always separates a full cell from its neighbour and text can never read as one word across a boundary (`p95 141router`). Only the last column, which has no neighbour, may use all 24 — that is what keeps the traffic sparklines intact.

This is why the `p50`/`p95` and `10s`/`60s` markers live in the section header rather than inline on each row: `internet ` (9) plus two inline markers and their separators leaves 5 cells for two numbers in a 23-cell budget, which cannot hold 4-digit satellite RTTs (`internet    12000 12000`) or `internet     100% 100%▲`. With the markers hoisted, both rows are label + two right-aligned value columns ending at cells 17 and 23.

DOWN example (rows 3–8):

```
  ● DOWN · uplink     DOWN 0:42     3 drops in 15m
  Plane's uplink dropped — router fine, it's not you. Drops here usually last ~22s (longest 1m04s).
────────────────────────────────────────────────────────────────────────────────────────────────────
  CHAT ✘ NO offline    BROWSE ✘ NO offline    VIDEO ✘ NO offline    DOWNLOAD ✘ NO offline
────────────────────────────────────────────────────────────────────────────────────────────────────
  PATH  Wi-Fi ✔ -72dBm → Router ✔ 8ms → Internet ✘ no reply 42s → DNS ✘ → Web ✘ connect
```

Glyphs: `✔` green, `~` yellow, `✘` red, `–` dim (no icmp), `?` dim (unknown). Timeline cells: `█` UP (green), `▓` DEGRADED (yellow), `▒` PORTAL (magenta), `░` DOWN/NO_LINK (red), `·` WARMUP/gap. Label row places `▲HH:MM cause` under each drop start (right-most wins on collision), `-15m` at left, `now` at right. The banner is rendered inverse for 2 ticks after any confirmed transition. `--ascii` maps `✔ ~ ✘ – ? ▲ ▼ █ ▓ ▒ ░ ·` to `OK ~ X - ? ^ v # = : . .` and the sparkline to `_.-=+*#@`.

### 8.2 Compact layout (< 100 cols or < 27 rows) — mockup at 80×24

```
 netmon  en1 · gw 192.168.0.1 · dns 100.100.100.100 (ts)     14:32:07  run 18m44s
────────────────────────────────────────────────────────────────────────────────
  ● UP · OK (B)     steady 4m12s     getting worse ▲     3 drops in 15m
  Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no
  CHAT ✔ OK            BROWSE ✔ OK            VIDEO ~ SHAKY jitter 71ms
  DOWNLOAD ✘ NO 3 drops/15m
  PATH  Wi-Fi ✔ → Router ✔ → Internet ✔ 48ms → DNS ✔ 31ms → Web ✔
────────────────────────────────────────────────────────────────────────────────
  LATENCY (60s) p50   p95              LOSS          10s   60s
  router          7    11              router         0%    0%
  internet       48    86              internet       0%    2%
  jitter        71 ms ▲                5m 4%   blips 1   late 0
  http     0.31 s (200)                unmeasured 0   errs 0
  wifi -72 dBm snr 23 tx 216 · in 42 KB/s out 6 KB/s · 38.2 MB↓ 4.1 MB↑
────────────────────────────────────────────────────────────────────────────────
 LAST 15m ████████░░██████████████▒▒▒▒████████████████░░░█████████████████████
          -15m   ▲14:19 wifi   ▲14:21 portal        ▲14:27 uplink           now
────────────────────────────────────────────────────────────────────────────────
  DROPS  3  14:27:55  22s     uplink        3 drops/15m · median 22s · max 1m04s
         2  14:21:10  1m04s   portal        last ended 4m12s ago · uptime 91%
         1  14:19:02  9s      wi-fi link    usually ~22s; 2 of 3 under 30s
  TIP  Tailscale DNS is 12x slower than direct — consider pausing it.
  q quit  t speed test (250 KB)  b bell:on  o open portal        probes ~1.2 MB/h
```

`planLayout(size)` places sections by priority while rows remain: header 1, banner 2, activities (1 at ≥ 100 cols, 2 below), path 1, footer 1 (pinned to the last row), then timeline 2, metrics (6 full incl. sparkline / 6 compact incl. the wifi+traffic line), drops 4 (3 at < 27 rows), tip 1; rule lines are added last, only where rows remain, in top-to-bottom order. Timeline: 90 cells × 10 s at ≥ 100 cols, 60 cells × 15 s below. Below 72×18 the frame is only `terminal too small (need 72x18, have CxR)`. Every line is padded/truncated to exactly `cols` visible characters (ANSI-aware); the body never scrolls.

### 8.3 Terminal handling (`src/ui/tty.ts`, `src/ui/frame.ts`)

- TUI mode requires `process.stdout.isTTY` and `typeof process.stdin.setRawMode === 'function'`; otherwise (or with `--plain`) plain mode (§8.5). `setRawMode` is undefined off-TTY in Bun 1.4, so this check happens before any escape is written.
- Enter: `\x1b[?1049h` (alt screen), `\x1b[?25l` (hide cursor), raw mode. Frame write: one `stdout.write` per tick composed of `\x1b[H` then, per row r, `\x1b[<r>;1H` + line + `\x1b[K`; never a full clear (no flicker). Render each tick and immediately on key/resize/transition, capped at 4 frames/s.
- Resize: `process.stdout.on('resize')` and, belt-and-braces, comparing `columns/rows` every tick; either triggers a repaint.
- Shutdown (idempotent, `shutdown(reason)`): bound to `q`, `\x03` (Ctrl-C in raw mode), SIGINT, SIGTERM, SIGHUP, `process.on('exit')`, `uncaughtException`, `unhandledRejection`. Steps: stop ticker, `killAll()` children, flush/close log, `\x1b[?25h`, `\x1b[?1049l`, raw mode off, print the quit report (§8.6) to stdout, exit 0 (1 for uncaught errors, after printing the message).

### 8.4 Keys (`src/ui/keys.ts`)

| Key | Action |
|---|---|
| `q`, Ctrl-C | quit |
| `t` | run the 250 KB speed test (rate-limited; refused while not UP/DEGRADED) |
| `b` | toggle bell on/off (footer shows `bell:on`/`bell:off`) |
| `o` | `/usr/bin/open <redirectUrl from the last portal result, else --portal-url, else http://captive.apple.com/hotspot-detect.html>` |
| `v` | switch between the simple view (default) and the advanced view (§8.8) |

No other keys. Unknown keys are ignored.

### 8.5 Plain mode (`src/ui/plain.ts`)

One line per second, no escapes:

```
14:32:07 UP B steady 4m12s | gw 7ms 0% | inet p50 48 p95 86 jit 71 loss 2% | dns 31/380 | http ok 0.31s | wifi -72 | in 42K out 6K | CHAT OK BROWSE OK VIDEO SHAKY DOWNLOAD NO
```

Plus one `EVENT` line per confirmed transition and per closed outage. Ctrl-C arrives as SIGINT → shutdown.

### 8.6 Quit report (`src/model/summary.ts`)

Printed to stdout after leaving the alt screen so it lands in scrollback:

```
netmon 14:32:07 — 18m44s on en1 (gw 192.168.0.1). UP (B): internet 48ms p50 / 86 p95, loss 2%, jitter 71ms, Wi-Fi -72 dBm.
3 drops (median 22s, longest 1m04s), last ended 4m12s ago, uptime 15m 91%. Chat OK · Browse OK · Video shaky (jitter 71ms) · Downloads no (3 drops/15m).
Probe traffic 0.4 MB.
 #  started   lasted  cause
 3  14:27:55  22s     uplink (router fine)
 2  14:21:10  1m04s   portal login needed
 1  14:19:02  9s      wi-fi link lost
```

### 8.7 Alerts (`src/actions/alerts.ts`)

Terminal bell `\x07` on confirmed transitions: → DOWN/NO_LINK 1×, → PORTAL 2×, outage → UP/DEGRADED 2×; at most one burst per 5 s; off with `b` or `--no-bell`. Banner inverse flash for 2 ticks regardless. No macOS notifications.

### 8.8 Simple view

The default TUI screen. Layout, sections, colors, glyphs and edge cases are specified in `docs/superpowers/specs/2026-10-02-simple-view-design.md`. Minimum 40×10; `v` toggles to the advanced view (§8.1/§8.2, minimum 72×18), whose too-small message points back at `v`.

## 9. Process primitive (`src/core/proc.ts`)

```ts
type RunResult = { ok: boolean; code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; err?: 'ENOENT' | 'SPAWN' };
run(argv: string[], timeoutMs: number): Promise<RunResult>
```

`Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })`; a timer sends SIGTERM at `timeoutMs`, SIGKILL 500 ms later; spawn exceptions are caught (`ENOENT` → `err`); never throws; `ok = code === 0 && !timedOut && !err`. Every child is added to a registry so `killAll()` can SIGTERM them on shutdown.

```ts
type StreamHandle = { kill(): void; pid: number; startedAt: number };
streamLines(argv: string[], h: { onLine(line: string, src: 'stdout' | 'stderr'): void; onExit(code: number | null): void }): StreamHandle
```

Reads both pipes with `TextDecoder`, splits on `\n`, delivers complete lines; partial trailing data is buffered.

`preflight(paths: string[]): Promise<Set<string>>` returns the missing binaries via `Bun.file(p).exists()`.

## 10. Failure handling

| Situation | Behavior |
|---|---|
| Fully offline at start | route probe fails → NO_LINK within 1 s with cause; streams keep running (pinging an unknown gateway is skipped: stream not started until `pingGateway` exists; the target stream runs and records LOST/LOCAL_ERROR); route probe at 2 s cadence; reconnection detected within ~2 s of the route returning |
| Interface drops mid-run | `sendto: No route to host` on stderr → link down immediately; route poller retargets gateway stream when a new gateway appears |
| Gateway changes (DHCP renew, re-association) | gateway stream retargeted, generation bump, no loss attributed to the swap |
| Gateway ignores ICMP | `gwNoIcmp`: hop shows `– no icmp`, never a DOWN(router) |
| Airline filters ICMP to the internet | up to one 2–4 s DOWN blip avoided by confirmation grace; latch after 30 s; HTTP authority thereafter |
| ping process hangs / exits | stall → UNMEASURED (not loss); restart with backoff; `errs` counter |
| curl/dig timeouts | hard `-m`/`+time` plus process kill; result kinds `fail`/`TIMEOUT` never crash; `dnsfail` is not DOWN evidence |
| system_profiler slow/hung | `-nospawn` (no unkillable helper); killed at 40 s; value ages on screen; `—` after 150 s; backoff after 3 failures |
| Binary missing | probe disabled at preflight, cell shows `<tool>: missing` (`profiler: missing` for system_profiler, which would otherwise fill all 24 cells), everything else continues |
| Non-TTY stdin/stdout | plain mode automatically |
| Terminal too small | single-line message, sampling continues |
| Laptop sleep | gap ≥ 5 s: outage closed as sleep, timeline `·`, uptime denominators exclude it, streams restarted, WARMUP |
| Speed test fails | `test failed` in TRAFFIC cell; not a drop; bytes actually transferred counted |
| Log write error | logging self-disables; footer shows `log: off (EACCES)` |
| Uncaught exception | terminal restored, one-line error printed, exit 1 |

## 11. JSONL log (`src/log/jsonl.ts`)

Enabled by `--log [path]` (default path `~/netmon-YYYYMMDD-HHMM.jsonl`); off by default; no runtime toggle. Written through `Bun.file(path).writer()` with a flush every second and on shutdown. One JSON object per line; `t` = epoch ms, `m` = monotonic ms since start.

The `meta` row is written at the **first route poll**, not at open, so it can carry `iface`/`wifiIface`/`gateway`/`vpn`; rows produced before it are buffered and emitted immediately after it, and if no route poll has arrived by the second tick the header is written without them. Every timestamp in every row is an integer ms.

```
{"kind":"meta","v":1,"t":1757168003123,"m":0,"argv":["--target","1.1.1.1"],"iface":"en1","wifiIface":"en1","gateway":"192.168.0.1","target":"1.1.1.1","vpn":false}
{"kind":"tick","t":1757168004123,"m":1000,"state":"UP","cause":null,"grade":"B","sat":false,"gwRtt":7.1,"gwLoss60":0,"inetRtt":48.2,"p50":48,"p95":86,"jitter":71,"loss10":0,"loss60":2,"late60":0,"unmeasured60":0,"http":"ok","httpMs":310,"dnsDirectMs":31,"dnsSysMs":380,"dnsOk":true,"rssi":-72,"noise":-95,"txRate":216,"inKBs":42,"outKBs":6,"loaded":false,"icmpBlocked":false}
{"kind":"event","t":...,"m":...,"event":"transition","from":"UP","to":"DOWN","cause":"uplink","startedAt":1757168040000}
{"kind":"event","t":...,"m":...,"event":"outage","cause":"uplink","startedAt":1757168040000,"endedAt":1757168062000,"durationS":22,"sleep":false}
{"kind":"event","t":...,"m":...,"event":"route","iface":"en1","gateway":"192.168.0.1","vpn":false}
{"kind":"event","t":...,"m":...,"event":"speed","downMbps":22.4,"bytes":250000,"ms":180}
{"kind":"event","t":...,"m":...,"event":"gap","fromT":1757169000000,"toT":1757170210000,"gapS":1210}
{"kind":"event","t":...,"m":...,"event":"wifi","rssi":-72,"noise":-95,"txRate":216,"mcs":4,"channel":"157 (5GHz, 80MHz)","phy":"802.11ax","assoc":"yes"}
```

Numbers are `null` when unknown. `inetRtt`/`gwRtt` are the latest received sample of that second. About 300 B/s ≈ 1 MB/h on disk.

## 12. CLI

```
bun run src/main.ts [options]
  --target <ip>        internet ping/route target (default 1.1.1.1); an IPv4 address,
                       validated before any probe starts — `route -n get` and `ping`
                       need an address, and a hostname there fails every route poll
                       (NO LINK on a healthy network). A bad value exits 2 with usage.
  --iface <name>       force the Wi-Fi interface (default: networksetup lookup)
  --log [path]         write JSONL (default path ~/netmon-YYYYMMDD-HHMM.jsonl)
  --portal-url <url>   URL for the o key when no redirect was captured
  --plain              one status line per second, no full-screen UI
  --advanced           start in the detailed view (default: the simple view)
  --ascii              ASCII glyphs instead of Unicode
  --no-color           no ANSI colors (NO_COLOR env also respected)
  --no-bell            start with the bell off
  --help
```

`package.json`: `{"name":"netmon","type":"module","scripts":{"start":"bun run src/main.ts","test":"bun test"}}` — no `dependencies`.

## 13. Modules

Every file ≤ 300 lines (targets below); every pure module is unit-tested.

| File | Responsibility | Exports | Lines |
|---|---|---|---|
| `src/main.ts` | Entry: parseArgs → preflight → build Store/pollers/streams/ticker → TUI or plain → shutdown wiring | `main(): Promise<void>` | 90 |
| `src/config.ts` | Constants from §3, thresholds from §7, binary paths | `const` objects | 90 |
| `src/cli/args.ts` | Hand-rolled flag parser | `parseArgs(argv: string[]): Options`, `Options`, `usage(): string` | 70 |
| `src/core/proc.ts` | §9 | `run`, `streamLines`, `killAll`, `preflight`, `RunResult`, `StreamHandle` | 110 |
| `src/core/clock.ts` | Monotonic/wall time, 1 s ticker with gap detection | `monoNow(): number`, `wallNow(): number`, `class Ticker { start(onTick: (now: number, gapMs: number) => void): void; stop(): void }` | 50 |
| `src/core/ring.ts` | Fixed-capacity ring of timestamped items with `since(ms)` | `class RingBuffer<T> { push; last(n); since(t); toArray(); size }` | 70 |
| `src/core/stats.ts` | Pure numeric helpers | `percentile(sorted, p)`, `median`, `mean`, `jitter(rtts)`, `lossPct(samples)` | 70 |
| `src/core/format.ts` | Durations (`4m12s`, `0:42`), bytes, rates, ms, ago, ANSI-aware `padEnd`/`truncate`/`visibleWidth` | as named | 110 |
| `src/probes/types.ts` | `PingEvent`, `PingSample`, `SampleState`, `HttpResult`, `HttpsResult`, `DnsResult`, `WifiInfo`, `CounterSample`, `RouteInfo`, `SpeedResult` | types | 90 |
| `src/probes/route.ts` | §4.1 | `parseRouteGet(s)`, `parseNwiAddress(s, iface)`, `parseHardwarePorts(s)`, `parseIpconfigRouter(s)`, `class RoutePoller { start(onInfo); setFast(b); stop() }` | 150 |
| `src/probes/ping-parse.ts` | §4.2 line parser | `parsePingLine(line: string): PingEvent` | 50 |
| `src/probes/ping-stream.ts` | Spawn, feed parser, stall watchdog, restart/backoff, generation, retarget | `class PingStream { start(host); retarget(host); stop(); onEvent(cb: (e: PingEvent, at: number, gen: number) => void); stalled(now): boolean }` | 140 |
| `src/probes/http.ts` | §4.3 | `buildCaptiveArgs(detector)`, `parseCurlOut(stdout): {body, fields}`, `classifyCaptive(...)`, `class HttpPoller { start(onResult); setCadence(ms); triggerNow(); stop() }` | 140 |
| `src/probes/https.ts` | §4.4 | `classifyHttps(exit, code, body)`, `class HttpsPoller { start(onResult); triggerNow(); stop() }` | 80 |
| `src/probes/dns.ts` | §4.5 | `parseDig(stdout, exit): DnsResult`, `nextName(round): string`, `class DnsPoller { start(onPair); stop() }` | 100 |
| `src/probes/wifi.ts` | §4.6 | `parseAirportJson(json, iface): WifiInfo | null`, `class WifiPoller { start(iface, onInfo); setIface(i); stop() }` | 110 |
| `src/probes/counters.ts` | §4.7 | `parseNetstat(stdout, iface): {ibytes, obytes} | null`, `class CounterPoller { start(onSample); setIface(i); stop() }` | 90 |
| `src/probes/speed.ts` | §4.9 | `parseSpeedOut(stdout, exit): SpeedResult`, `runSpeedTest(): Promise<SpeedResult>`, `canRun(now, last, state): {ok, why?}` | 80 |
| `src/model/samples.ts` | Per-stream seq-keyed window, settle/synthesize, link hysteresis | `class SampleWindow { onEvent(e, at, gen); tick(now, stalled); settled(sinceMs): PingSample[]; linkState(): 'up'|'down'|'unknown'; downSince: number|null; stats(windowMs, idleOnly): StreamStats }` | 170 |
| `src/model/store.ts` | Holds windows, latest probe results, settings; builds `Snapshot` each tick | `class Store`, `type Snapshot`, `computeSnapshot(store, now): Snapshot` | 160 |
| `src/model/signals.ts` | `Snapshot` → `Signals` (§6.2 inputs incl. `inetOk`, `icmpBlocked`, `gwNoIcmp`, `portalSignal`) | `deriveSignals(store, now): Signals`, `Signals` | 120 |
| `src/model/status.ts` | Candidate table, debounce, transitions with backdated timestamps, cause rewrite, grace | `evaluateCandidate(sig): Candidate`, `class StatusMachine { tick(sig, now): Transition | null; state; cause; since }` | 150 |
| `src/model/grade.ts` | §7.2 incl. caps and hold | `rawGrade(inputs): Grade`, `applyCaps(g, ctx): {grade, tags}`, `class GradeHold { push(g): Grade }` | 90 |
| `src/model/satellite.ts` | §7.1 | `updateSat(prev, p10, loss120): {sat, rttOffset}` | 40 |
| `src/model/verdicts.ts` | §7.4 | `activityVerdicts(snap): Verdict[]` (`{name, level:'OK'|'SHAKY'|'NO'|'?', reason}`) | 150 |
| `src/model/banner-text.ts` | §7.5 | `bannerLines(snap): [string, string]` | 110 |
| `src/model/outages.ts` | Outage records, sleep close, stats, timeline buckets | `class OutageTracker { onTransition(t); onGap(from, to); tick(state, now); stats(now): DropStats; timeline(now, cells, cellMs): CellState[] }` | 160 |
| `src/model/trend.ts` | §7.3 | `computeTrend(snap): Trend` | 60 |
| `src/model/tips.ts` | §7.6 | `pickTip(snap): string | null` | 80 |
| `src/model/budget.ts` | §4.10 | `class Budget { add(kind, bytes?); total; perHourEstimate }` | 40 |
| `src/model/summary.ts` | §8.6 | `quitReport(snap): string` | 70 |
| `src/ui/ansi.ts` | CSI constants, `color(name, s, enabled)`, `strip(s)`, glyph tables (unicode/ascii) | as named | 70 |
| `src/ui/tty.ts` | §8.3 | `class Tty { canTui(): boolean; enter(h: {onKey, onResize}); leave(); size(): {cols, rows}; write(frame) }`, `onShutdown(fn)`, `shutdown(reason)` | 120 |
| `src/ui/frame.ts` | Assemble sections into exactly rows × cols, home + per-line clear | `renderFrame(lines: string[], size): string`, `fitLine(s, cols): string` | 70 |
| `src/ui/layout.ts` | §8.2 planning | `planLayout(size): LayoutPlan` (`{sections: SectionId[], rules: number[], compact, timelineCells, cellMs}`) | 100 |
| `src/ui/sections/header.ts` | Row 1 | `header(snap, w): string[]` | 50 |
| `src/ui/sections/banner.ts` | Rows 3–4 + flash | `banner(snap, ui, w): string[]` | 60 |
| `src/ui/sections/activities.ts` | Activity strip (1 or 2 rows) | `activities(snap, plan): string[]` | 60 |
| `src/ui/sections/path.ts` | Hop chain, abbreviated in compact | `path(snap, plan): string[]` | 80 |
| `src/ui/sections/metrics.ts` | LATENCY/LOSS/WI-FI/TRAFFIC cells, compact variant | `metrics(snap, plan): string[]` | 150 |
| `src/ui/sections/sparkline.ts` | RTT (log scale, `x` for lost) and KB/s sparklines, timeline glyphs | `sparkline(values, width, opts)`, `timelineBar(cells, glyphs)` | 70 |
| `src/ui/sections/timeline.ts` | Bar + marker row with collision handling | `timeline(snap, plan): string[]` | 90 |
| `src/ui/sections/drops.ts` | Table + stats column | `drops(snap, plan): string[]` | 80 |
| `src/ui/sections/footer.ts` | TIP row and key row with live states | `tip(snap, w): string[]`, `footer(snap, ui, w): string[]` | 60 |
| `src/ui/plain.ts` | §8.5 | `renderPlainLine(snap): string`, `renderPlainEvent(t): string` | 50 |
| `src/ui/keys.ts` | Key dispatch | `bindKeys(tty, actions: {quit, speed, bell, portal}): void` | 40 |
| `src/actions/alerts.ts` | §8.7 | `class Alerter { onTransition(t, now); toggle(); enabled }` | 50 |
| `src/actions/open-portal.ts` | `open` helper | `openPortal(url: string): Promise<void>`, `portalUrl(snap, opts): string` | 30 |
| `src/log/jsonl.ts` | §11 | `class JsonlLogger { static open(path): Promise<JsonlLogger | null>; tick(snap); event(e); close() }`, `tickRow(snap): object` | 90 |

Pure (no I/O) and unit-tested: `stats`, `format`, `ring`, all `parse*`/`classify*`/`build*` functions, `samples`, `signals`, `status`, `grade`, `satellite`, `verdicts`, `banner-text`, `outages`, `trend`, `tips`, `budget`, `summary`, `layout`, `frame`, every `ui/sections/*`, `plain`, `args`, `jsonl.tickRow`. Side-effecting: `proc`, `clock`, the `*Poller`/`PingStream` classes, `tty`, `alerts`, `open-portal`, `JsonlLogger` I/O, `main`.

Tests (`bun test`), with fixtures captured from this machine under `tests/fixtures/`:

| File | Covers |
|---|---|
| `tests/ping-parse.test.ts` | reply (`24 bytes from`), DUP, timeout, `sendto` stderr, header/stats ignored, unknown line |
| `tests/samples.test.ts` | seq keying, LATE flip, synthesized LOST after deadline, UNMEASURED on stall, generation reset, link hysteresis 3-lost/2-received, local error → down, stats exclude UNMEASURED |
| `tests/route-parse.test.ts` | `route -n get` ok / `not in table` / utun egress, `scutil --nwi` address + 169.254, hardware-port mapping, `ipconfig` router |
| `tests/http-classify.test.ts` | apple 200 Success, google 204 empty, 302 with redirect, 200 without Success, 511, curl exit 6/7/28 → dnsfail/fail, `|` split with empty redirect_url, `\n@@|` split with empty body |
| `tests/https-classify.test.ts` | 200 with `ip=`, exit 35/60 → portal, exit 28 → fail |
| `tests/dig-parse.test.ts` | NOERROR, NXDOMAIN ok, SERVFAIL, exit 9 timeout, Query time / SERVER extraction, name rotation with cache-buster |
| `tests/airport-parse.test.ts` | en1 + awdl0 fixture selects en1, `<redacted>` SSID, not connected, missing interface |
| `tests/netstat-parse.test.ts` | en1 11-token row, utun 10-token row, missing iface, header only |
| `tests/speed-parse.test.ts` | ok, partial download, non-200, timeout |
| `tests/stats.test.ts` | nearest-rank percentile, jitter, loss |
| `tests/signals-status.test.ts` | scripted sequences: clean drop → DOWN(uplink) at +4 s backdated; gateway+internet loss with weak RSSI → wifi; gateway no-icmp stays UP; ICMP-filtered network with grace → no DOWN, latch after 30 s; portal enter/exit rules incl. whitelisted detector; NO_LINK causes; WARMUP → UP; dnsfail is not DOWN; sleep gap |
| `tests/grade.test.ts` | tier boundaries, every cap, satellite offset, hold |
| `tests/verdicts.test.ts` | each rule boundary per activity, reasons ≤ 28 chars, `?` in WARMUP |
| `tests/outages.test.ts` | open/close, cause rewrite, median/longest/gap, uptime excluding gaps, timeline worst-per-cell |
| `tests/trend.test.ts`, `tests/tips.test.ts`, `tests/banner-text.test.ts`, `tests/summary.test.ts` | phrase selection |
| `tests/layout-frame.test.ts` | 100×30, 80×24, 72×18, 60×16 (too small): exact row count, every line ≤ cols after `strip`, footer on last row, ascii mode |
| `tests/args.test.ts`, `tests/jsonl.test.ts` | flag parsing, tick row shape |

## 14. Errors found by the judges andtheir fixes

| Finding | Fix in this spec |
|---|---|
| `-W 1000` on the stream ping silently turns replies > 1 s into loss | No `-W`; LATE replies parsed and counted as received with their RTT (§4.2) |
| Timeout lines plus seq gaps double-count loss | One record per `(generation, seq)`; the deadline backstop only fills seqs with no record (§4.2) |
| `sendto` error lines emitted on stderr; stdout-only pipe misses them | Both pipes streamed; error sets link down, no extra sample (§4.2) |
| macOS ping prints a timeout line only when cumulative missing exceeds the previous max | Deadline-based synthesis at send time + 2 s (§4.2) |
| Watchdog-synthesized loss could open a spurious outage after a restart | Stalled seconds are UNMEASURED, never loss, never open an outage (§4.2, §5) |
| `curl -w` space separator collapses on empty `redirect_url` | `|` separator and `\n@@|` marker (§4.3) |
| Captive rule turned curl failures into PORTAL | Exit code checked first; only exit 0 results can be `portal` (§4.3) |
| Portal whitelisting one detector | Alternating detectors, two-portal entry, two-ok exit, HTTPS `ok` exit (§4.3, §6.1) |
| `netstat` `<Link#>` is the Network column; utun/lo0 rows have 10 tokens | Third-token match, parse from the end (§4.7) |
| Text-mode `system_profiler` parse can pick awdl0's block | `-json`, select `_name === iface` (§4.6) |
| 25–30 s profiler cadence runs the 13 s command half the time | 60 s cadence, 25 s kill, 120 s backoff (§4.6) |
| NO_WIFI conflated not-joined with joined-but-no-DHCP | NO_LINK causes from `spairport_status_information` and 169.254.x (§6.2) |
| Gateway that ignores ICMP produces permanent DOWN(router) | Router failure implicates the local link only when the internet is also down; otherwise `gwNoIcmp` (§6.1) |
| `inetOk` freshness hole at 12–14 s and 30 s stale HTTP masking real drops | HTTP success must postdate the ICMP failure; out-of-band confirmation with 5 s grace (§6.2) |
| Absolute RTT thresholds grade a healthy GEO link C/D forever | Satellite mode with baseline offset for grade and activities (§7.1) |
| 20 s windows make p95 = max-of-20 | 60 s main window, 10 s loss for fast reaction (§5) |
| ±3 dBm two-sample RSSI trend flips the banner on noise | RSSI trend removed; latency/loss over 60 s halves (§7.3) |
| Speed-test bytes pollute jitter/trend | `loaded` tagging; idle samples preferred; `~` marker (§4.8) |
| `dig +short` omits Query time; wall time includes spawn cost | `+noall +comments +stats`, parse `Query time` (§4.5) |
| `route -n get default` misses interface-scoped VPN routes | `route -n get <target>`; `ipconfig getoption` + `listallhardwareports` for the physical link (§4.1) |
| Chat OK at 30 % / MEH at 60 % loss indefensible | CHAT OK ≤ 15 %, SHAKY above (§7.4) |
| Non-TTY stdin throws on `setRawMode` | Checked before entering the TUI; plain mode (§8.3) |
| Data budget counted one direction | Both directions, `-s 16`, honest ≈ 1.2 MB/h shown in the footer (§4.10) |
| `networksetup -setairportpower` needs admin privileges | Removed |
| Mathis ceiling, bufferbloat from a 0.18 s download | Removed |
| One-shot `ping -c 1 -W 1500` takes 2.53 s and races its timeout | Not used; streams only |

## 15. Decisions & rationale

- **Design 0's screen on Design 2's chassis with Design 1's engine.** Usefulness was the only criterion all judges scored identically (D0 9/9/9); correctness and robustness are grafted as modules with the same interfaces, not as a different product.
- **Two long-lived ping streams, no `-W`, `-s 16`.** One process per target for the whole session is cheaper than one spawn per second, keeps 1 Hz sampling during outages, and, without `-W`, records satellite-range RTTs as latency rather than loss. `-s 16` halves ICMP bytes and still prints `time=`.
- **HTTP is the authority for "internet OK", ICMP for speed of detection.** ICMP flips the link state in 3 s; an HTTP success only vouches for the internet if it postdates the ICMP failure, so real drops are confirmed in ~4 s while ICMP-filtered networks are not misreported after the first 30 s.
- **Probe errors are never loss.** A hung `ping`, a killed `system_profiler`, a missing `dig` render as UNMEASURED/`?`/`errs`, so "couldn't measure" can never become "the plane is down".
- **60 s windows, hysteresis in the signals, a 5-tick grade hold.** Flicker at thresholds is the most annoying UX failure on a flapping link; smoothing lives in pure code that is unit-tested with scripted sequences.
- **Satellite mode is baseline-relative, not a flag.** The user should not need to know whether the plane is GEO or air-to-ground; the offset is derived from 120 s of p10 latency and shown in the header.
- **Four keys, four activities, one opt-in probe.** Everything the judges cut (Wi-Fi bounce, notifications, clipboard, pause, help overlay, events list, upload probe, second anycast target, stream verdict, auto speed tests, replay) is out; the footer explains the remaining keys.
- **Sleep-gap handling kept, minimal.** Closing the lid mid-flight is common; a phantom 20-minute outage would poison the drop stats the tool exists to provide. It is ~30 lines in the outage tracker.
- **Quit report kept.** It is the only persistence when `--log` is off, needs no key, and reuses the drop stats already computed.
- **JSONL by flag only, format frozen at `v:1`.** No consumer ships in this version; the format is documented so a summary tool can be added later without changing the monitor.
- **Ordered candidate table with a catch-all.** Every combination of signals lands on exactly one state and cause; the ordering is the spec, and `evaluateCandidate` is a pure function tested row by row.

## 16. Non-goals

- Post-flight tooling: `--replay`, `--summary`, log toggling at runtime, session reset.
- Upload throughput, bufferbloat, Mathis/TCP-ceiling estimates, egress IP/PoP display.
- A second anycast ping target; per-target routing diagnosis.
- Buffered-video "stream" verdict.
- Automatic or periodic speed tests; any flag that spends bandwidth without a keypress.
- Wi-Fi power cycling, `networksetup` writes, anything needing admin rights or sudo.
- macOS notifications, clipboard integration, help overlay, pause key, event list.
- IPv6 measurement (all probes are `-4`); non-Wi-Fi radios (Ethernet/USB tethering are monitored as a plain interface without radio data).
- Per-application traffic attribution; anything beyond interface-level passive counters.
- Config files, themes, plugins, or non-macOS platforms.
