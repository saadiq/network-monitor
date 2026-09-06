// §8.6 quit report. Pure: Snapshot → multi-line string (no trailing newline).
import { fmtBytes, fmtDuration, fmtMs, fmtPct, fmtTime, padEnd, padStart } from '../core/format';
import { GLYPHS, type Glyphs } from '../ui/ansi';
import { primaryReason, stateWord } from './banner-text';
import type { ActivityName, Cause, Outage, Snapshot, Verdict } from './types';

const ACTIVITY_LABEL: Readonly<Record<ActivityName, string>> = {
  CHAT: 'Chat', BROWSE: 'Browse', 'VIDEO CALL': 'Video', DOWNLOAD: 'Downloads',
};

/** Drop-table cause wording (§8.6 mockup). */
export function causeLabel(cause: Cause): string {
  switch (cause) {
    case 'uplink': return 'uplink (router fine)';
    case 'portal': return 'portal login needed';
    case 'wifi': return 'wi-fi link lost';
    case 'router': return 'router unreachable';
    case 'not-joined': return 'not joined to wi-fi';
    case 'no-dhcp': return 'no DHCP address';
    case 'unknown': return 'no route';
    default: return 'unknown';
  }
}

function headline(snap: Snapshot, g: Glyphs): string {
  const r = snap.route;
  const iface = r?.egressIface ?? r?.wifiIface ?? '?';
  const gw = r?.gateway ?? r?.pingGateway ?? null;
  const where = `on ${iface}${gw ? ` (gw ${gw})` : ''}`;
  const qual = snap.grade.grade ?? snap.cause;
  const head = `${stateWord(snap.state)}${qual ? ` (${qual})` : ''}`;
  const ms = (v: number | null): string => (v == null ? g.em : `${fmtMs(v)}ms`);
  const p50 = ms(snap.latencyMs);
  const inet = snap.latencySource === 'http'
    ? `internet ${p50} p50 (http)`
    : `internet ${p50} p50 / ${snap.latencyP95 == null ? g.em : fmtMs(snap.latencyP95)} p95`;
  const loss = snap.loss60 == null ? g.em : fmtPct(snap.loss60);
  const rssi = snap.wifi?.rssi;
  const wifi = rssi == null ? '' : `, Wi-Fi ${rssi} dBm`;
  return `netmon ${fmtTime(snap.wall)} ${g.em} ${fmtDuration(snap.runS)} ${where}. ${head}: ${inet}, loss ${loss}, jitter ${ms(snap.jitter)}${wifi}.`;
}

function verdictPhrase(v: Verdict): string {
  const level = v.level === 'OK' ? 'OK' : v.level.toLowerCase();
  const reason = v.level === 'OK' ? '' : primaryReason(v.reason);
  return `${ACTIVITY_LABEL[v.name]} ${level}${reason ? ` (${reason})` : ''}`;
}

function dropsLine(snap: Snapshot, g: Glyphs): string {
  const d = snap.drops;
  const dur = (s: number | null): string => (s == null ? g.em : fmtDuration(s));
  let s: string;
  if (d.dropsSession === 0) {
    s = 'No drops';
  } else {
    const n = d.dropsSession;
    const stats = n === 1 ? dur(d.dropLongestS) : `median ${dur(d.dropMedianS)}, longest ${dur(d.dropLongestS)}`;
    s = `${n} drop${n === 1 ? '' : 's'} (${stats})`;
    if (d.sinceLastDrop != null) s += `, last ended ${fmtDuration(d.sinceLastDrop)} ago`; // mockup: 4m12s ago
  }
  if (d.uptime15 != null) s += `, uptime 15m ${Math.round(d.uptime15)}%`;
  return `${s}. ${snap.verdicts.map(verdictPhrase).join(` ${g.sep} `)}.`;
}

function outageRow(o: Outage, nw: number): string {
  let label = causeLabel(o.cause);
  if (o.endedAt == null) label += ' (ongoing)';
  else if (o.sleep) label += ' (closed by sleep)';
  return `${padStart(String(o.n), nw)}  ${fmtTime(o.startedAt)}  ${padEnd(fmtDuration(o.durationS), 6)}  ${label}`;
}

/** ` #  started   lasted  cause` + one row per outage (open first, then newest first); [] when none. */
function outageTable(snap: Snapshot): string[] {
  const rows = snap.openOutage ? [snap.openOutage, ...snap.outages] : snap.outages;
  if (rows.length === 0) return [];
  let nw = 2;
  for (const o of rows) nw = Math.max(nw, String(o.n).length);
  const head = `${padStart('#', nw)}  ${padEnd('started', 8)}  ${padEnd('lasted', 6)}  cause`;
  return [head, ...rows.map((o) => outageRow(o, nw))];
}

/** §8.6 report printed after leaving the alt screen; lines joined with `\n`. */
export function quitReport(snap: Snapshot, g: Glyphs = GLYPHS.unicode): string {
  return [
    headline(snap, g),
    dropsLine(snap, g),
    `Probe traffic ${fmtBytes(snap.probeBytes)}.`,
    ...outageTable(snap),
  ].join('\n');
}
