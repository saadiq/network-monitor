// §8.5 plain mode: one escape-free status line per second plus EVENT lines. Pure.
import { fmtClock, fmtDuration, fmtMs, fmtRateShort, fmtSecs, fmtTime } from '../core/format';
import { isOffline, type Outage, type Snapshot, type Transition, type Verdict } from '../model/types';
import type { DnsResult } from '../probes/types';

const NA = '-';

const num = (v: number | null): string => (v == null ? NA : fmtMs(v));
const pct = (v: number | null): string => (v == null ? NA : `${Math.round(v)}%`);
const withCause = (state: string, cause: string | null): string => (cause ? `${state}/${cause}` : state);

/** `UP B steady 4m12s` · `DOWN/uplink - down 0:42` · `WARMUP - warmup` · `DEGRADED/dns C~ steady 1m02s` */
function stateField(s: Snapshot): string {
  const grade = (s.grade.grade ?? NA) + (s.grade.underLoad ? '~' : '');
  let phase: string;
  if (s.state === 'WARMUP') phase = 'warmup';
  else if (isOffline(s.state)) phase = `down ${fmtClock(s.downFor ?? 0)}`;
  else phase = `steady ${fmtDuration(s.steadyFor)}`;
  return `${withCause(s.state, s.cause)} ${grade} ${phase}`;
}

/** `gw 7ms 0%` · `gw no-icmp` */
function gwField(s: Snapshot): string {
  if (s.gwNoIcmp) return 'gw no-icmp';
  const p50 = s.gw.p50 == null ? NA : `${fmtMs(s.gw.p50)}ms`;
  return `gw ${p50} ${pct(s.gw.loss60)}`;
}

/** `inet p50 48 p95 86 jit 71 loss 2%` · `inet http 120 jit 71 loss 2% (router)` when ICMP is blocked */
function inetField(s: Snapshot): string {
  const lat = s.latencySource === 'http'
    ? `http ${num(s.latencyMs)}`
    : `p50 ${num(s.latencyMs)} p95 ${num(s.latencyP95)}`;
  const src = s.lossSource === 'router' ? ' (router)' : '';
  return `inet ${lat} jit ${num(s.jitter)} loss ${pct(s.loss60)}${src}`;
}

const dnsMs = (r: DnsResult | null): string => (r == null ? NA : r.ok ? num(r.ms) : 'x');

/** `dns 31/380` (direct/system; `x` = failed, `-` = no result) */
function dnsField(s: Snapshot): string {
  return `dns ${dnsMs(s.dnsDirect)}/${dnsMs(s.dnsSys)}`;
}

/** `http ok 0.31s` · `http portal 1.8s` · `http -` */
function httpField(s: Snapshot): string {
  if (!s.http) return 'http -';
  return `http ${s.http.kind} ${s.http.ms == null ? NA : fmtSecs(s.http.ms, false)}`;
}

/** `wifi -72` · `wifi -72?` (stale) · `wifi ?` (reading) · `wifi off` (not the egress) */
function wifiField(s: Snapshot): string {
  if (s.wifiStatus === 'off') return 'wifi off';
  if (s.wifiStatus === 'reading' || !s.wifi) return 'wifi ?';
  const rssi = s.wifi.rssi == null ? NA : String(s.wifi.rssi);
  return `wifi ${rssi}${s.wifiStatus === 'stale' ? '?' : ''}`;
}

const rate = (kbs: number | null): string => (kbs == null ? NA : fmtRateShort(kbs * 1000));

/** `in 42K out 6K` */
function trafficField(s: Snapshot): string {
  return `in ${rate(s.inKBs)} out ${rate(s.outKBs)}`;
}

/** `CHAT OK BROWSE OK VIDEO SHAKY DOWNLOAD NO` */
function verdictField(vs: Verdict[]): string {
  return vs.map((v) => `${v.name === 'VIDEO CALL' ? 'VIDEO' : v.name} ${v.level}`).join(' ');
}

export function renderPlainLine(snap: Snapshot): string {
  return [
    `${fmtTime(snap.wall)} ${stateField(snap)}`,
    gwField(snap),
    inetField(snap),
    dnsField(snap),
    httpField(snap),
    wifiField(snap),
    trafficField(snap),
    verdictField(snap.verdicts),
  ].join(' | ');
}

/**
 * `14:32:07 EVENT UP -> DOWN/uplink since 14:32:03` for a confirmed transition;
 * `14:32:07 EVENT outage #3 DOWN/uplink 14:31:45 -> 14:32:07 lasted 22s` for a closed outage
 * (` (sleep)` when closed by a tick gap). Wall-clock stamps, no escapes.
 */
export function renderPlainEvent(t: Transition | Outage): string {
  if ('from' in t) {
    return `${fmtTime(t.wall)} EVENT ${t.from} -> ${withCause(t.to, t.cause)} since ${fmtTime(t.startedAt)}`;
  }
  const end = t.endedAt == null ? 'open' : fmtTime(t.endedAt);
  const sleep = t.sleep ? ' (sleep)' : '';
  return `${fmtTime(t.endedAt ?? t.startedAt)} EVENT outage #${t.n} ${withCause(t.state, t.cause)} `
    + `${fmtTime(t.startedAt)} -> ${end} lasted ${fmtDuration(t.durationS)}${sleep}`;
}
