// §8.1 WI-FI / TRAFFIC cells and the §8.2 compact `wifi … · in … · session` line. Pure.
import { BIN, METRIC_CELL_W, RATE_HISTORY_N } from '../../config';
import { fmtAgo, fmtBytes, fmtRate, padEnd, padStart, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import type { SnrLabel, WifiInfo } from '../../probes/types';
import type { ColorName, Glyphs } from '../ansi';
import { paint } from './common';
import { sparkline } from './sparkline';

const CHANNEL_RE = /^(\d+)\s*\((\d+(?:\.\d+)?GHz),\s*(\d+)MHz\)$/; // "157 (5GHz, 80MHz)"

function dbm(v: number | null | undefined, g: Glyphs): string {
  return v == null ? g.em : `${v} dBm`;
}

function num(v: number | null | undefined, g: Glyphs): string {
  return v == null ? g.em : String(v);
}

/** KB/s → `42 KB/s`; null (skipped delta) → em dash. */
function rate(kbs: number | null, g: Glyphs): string {
  return kbs == null ? g.em : fmtRate(kbs * 1000);
}

function labelColor(l: SnrLabel): ColorName {
  return l === 'good' ? 'green' : l === 'fair' ? 'yellow' : 'red';
}

/** `157 (5GHz, 80MHz)` → `ch157 5GHz/80`. */
export function channelText(ch: string | null | undefined, g: Glyphs): string {
  if (!ch) return g.em;
  const m = CHANNEL_RE.exec(ch);
  return m ? `ch${m[1]} ${m[2]}/${m[3]}` : `ch${ch}`;
}

function wifiHeader(snap: Snapshot, g: Glyphs): string {
  if (snap.wifiStatus === 'off') return 'WI-FI (off)';
  if (snap.wifiStatus === 'reading' || !snap.wifi) return `WI-FI (reading${g.ellipsis})`;
  return `WI-FI (${fmtAgo(snap.wifi.ageS)})`; // stale keeps the age; values go em (§4.6)
}

/** WI-FI cell: header + four rows (signal/snr, noise/label, tx/MCS, phy/channel). */
export function wifiCell(snap: Snapshot, g: Glyphs, on: boolean): string[] {
  if (snap.missingBins.includes(BIN.system_profiler)) return ['WI-FI', 'profiler: missing']; // ≤ 23 cells (K1)
  const head = wifiHeader(snap, g);
  if (snap.wifiStatus === 'off') return [head, 'not the egress'];
  const w: WifiInfo | null = snap.wifiStatus === 'ok' ? snap.wifi : null;
  if (w && w.assoc === 'no') return [head, 'not associated'];
  const label = w?.label ? paint(labelColor(w.label), w.label, on) : g.em;
  return [
    head,
    padEnd(`signal ${dbm(w?.rssi, g)}`, 17) + `snr ${num(w?.snr, g)}`,
    padEnd(`noise  ${dbm(w?.noise, g)}`, 17) + label,
    padEnd(`tx ${num(w?.txRate, g)} Mbps`, 13) + `MCS ${num(w?.mcs, g)}`,
    `${w?.phy ?? g.em} ${channelText(w?.channel, g)}`,
  ];
}

/** `session 38.2 MB↓ 4.1 MB↑` (space dropped when it would overflow w). */
export function sessionText(snap: Snapshot, g: Glyphs, w: number, prefix = 'session '): string {
  const a = fmtBytes(snap.sessionIn) + g.dl;
  const b = fmtBytes(snap.sessionOut) + g.ul;
  const s = `${prefix}${a} ${b}`;
  return visibleWidth(s) > w ? `${prefix}${a}${b}` : s;
}

/** Mbps → `↓2.8 MB/s`. */
function downRate(mbps: number, g: Glyphs): string {
  return g.dl + fmtRate((mbps * 1e6) / 8);
}

/** `test 12m ago: ↓2.8 MB/s` · `test 40s ago: failed` · `test — press t`. */
export function speedText(snap: Snapshot, g: Glyphs): string {
  const s = snap.speed;
  if (!s) return `test ${g.em} press t`;
  const ago = fmtAgo(s.ageS);
  if (!s.ok || s.downMbps == null) return `test ${ago}: failed`; // §10
  return `test ${ago}: ${downRate(s.downMbps, g)}`;
}

function rateRow(label: string, kbs: number | null, hist: (number | null)[], g: Glyphs): string {
  const spark = sparkline(hist.slice(-RATE_HISTORY_N), RATE_HISTORY_N, { lostGlyph: ' ', ramp: g.ramp });
  return padEnd(label, 3) + padStart(rate(kbs, g), 10) + ' ' + spark;
}

/** TRAFFIC cell: header, in/out with 10-sample sparklines, session totals, speed test. */
export function trafficCell(snap: Snapshot, g: Glyphs): string[] {
  const speed = speedText(snap, g);
  if (snap.missingBins.includes(BIN.netstat)) return ['TRAFFIC', 'netstat: missing', '', '', speed];
  return [
    `TRAFFIC (${snap.loadedNow ? 'loaded ~' : 'passive'})`, // §4.8
    rateRow('in', snap.inKBs, snap.inHistory, g),
    rateRow('out', snap.outKBs, snap.outHistory, g),
    sessionText(snap, g, METRIC_CELL_W),
    speed,
  ];
}

function wifiShort(snap: Snapshot, g: Glyphs): string {
  if (snap.missingBins.includes(BIN.system_profiler)) return 'wifi ?';
  switch (snap.wifiStatus) {
    case 'off': return 'wifi off';
    case 'stale': return `wifi ${g.em}`;
    case 'reading': return `wifi reading${g.ellipsis}`;
    default: break;
  }
  const w = snap.wifi;
  if (!w) return `wifi reading${g.ellipsis}`;
  if (w.assoc === 'no') return 'wifi not associated';
  return `wifi ${dbm(w.rssi, g)} snr ${num(w.snr, g)} tx ${num(w.txRate, g)}`;
}

/** §8.2 row 6: `wifi -72 dBm snr 23 tx 216 · in 42 KB/s out 6 KB/s · 38.2 MB↓ 4.1 MB↑` (+ speed when it fits w). */
export function compactLine(snap: Snapshot, g: Glyphs, w: number): string {
  const sep = ` ${g.sep} `;
  const traffic = snap.missingBins.includes(BIN.netstat)
    ? 'netstat: missing'
    : `in ${rate(snap.inKBs, g)} out ${rate(snap.outKBs, g)}`;
  const base = [wifiShort(snap, g), traffic, sessionText(snap, g, w, '')].join(sep);
  const s = snap.speed;
  if (!s) return base;
  const speed = s.ok && s.downMbps != null ? `test ${downRate(s.downMbps, g)} ${fmtAgo(s.ageS)}` : `test failed ${fmtAgo(s.ageS)}`;
  const full = base + sep + speed;
  return visibleWidth(full) <= w ? full : base;
}
