// §7.5 banner text. Pure: Snapshot → two untruncated lines; the UI fits them to width.
import { CAP_LOSS300_PCT, GRADE_TIERS, GRADE_WORDS, TAILSCALE_DNS } from '../config';
import { fmtClock, fmtDuration, fmtMsShort, fmtPct } from '../core/format';
import { GLYPHS, type Glyphs } from '../ui/ansi';
import { isOffline, type Snapshot, type State, type Verdict } from './types';

/** Segment separator for line 1 (the §8.1 mockups use 5–6 spaces). */
export const SEGMENT_SEP = '     ';

/** `NO_LINK` → `NO LINK`; other states unchanged. */
export function stateWord(state: State): string {
  return state === 'NO_LINK' ? 'NO LINK' : state;
}

/** Note separator inside a verdict reason: the unicode or the ascii `sep` glyph (§7.4). */
const NOTE_SEP = / [·|] /;

/** Verdict reason without the ` · audio ok` note (§7.4). */
export function primaryReason(reason: string): string {
  return reason.split(NOTE_SEP)[0] ?? reason;
}

/** `0.8s` · `1.8s` for "slow" reasons (§7.4 examples); falls back to fmtMsShort ≥ 10 s. */
function fmtSlow(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : fmtMsShort(ms);
}

// ---- line 1 -------------------------------------------------------------------

/** `● STATE` + ` · cause` (offline / dns / web) + ` · WORD (G)` when graded. */
function stateSegment(snap: Snapshot, g: Glyphs): string {
  let s = `${g.bullet} ${stateWord(snap.state)}`;
  const c = snap.cause;
  if (c != null && c !== 'portal' && c !== 'quality') s += ` ${g.sep} ${c}`;
  const gr = snap.grade.grade;
  if (gr != null) s += ` ${g.sep} ${GRADE_WORDS[gr]} (${gr})`;
  return s;
}

/** `steady 4m12s` (UP/DEGRADED) or `DOWN 0:42` ticking (offline); none in WARMUP. */
function clockSegment(snap: Snapshot): string | null {
  if (snap.state === 'UP' || snap.state === 'DEGRADED') return `steady ${fmtDuration(snap.steadyFor)}`;
  if (!isOffline(snap.state)) return null;
  const s = snap.downFor ?? Math.max(0, (snap.now - snap.since) / 1000);
  return `${stateWord(snap.state)} ${fmtClock(s)}`;
}

/** Line 1 pieces in order, each non-empty; join with SEGMENT_SEP or lay out freely. */
export function bannerSegments(snap: Snapshot, g: Glyphs = GLYPHS.unicode): string[] {
  const out: string[] = [stateSegment(snap, g)];
  const clock = clockSegment(snap);
  if (clock) out.push(clock);
  const t = snap.trend;
  if (t.phrase) out.push(t.overall === null ? t.phrase : `${t.phrase} ${t.overall === 'better' ? g.down : g.up}`);
  const n = snap.drops.drops15;
  if (n > 0) out.push(`${n} drop${n === 1 ? '' : 's'} in 15m`);
  if (snap.grade.tags.includes('FLAKY')) out.push('FLAKY');
  if (snap.sat) out.push(`sat +${snap.rttOffset}ms`);
  if (snap.grade.underLoad) out.push('~ under load');
  return out;
}

// ---- line 2 -------------------------------------------------------------------

/** `<expectation>` phrase for DOWN/PORTAL sentences (§7.5). */
export function expectation(snap: Snapshot): string {
  const d = snap.drops;
  if (d.dropsSession === 0 || d.dropLongestS == null) return 'First drop this session.';
  if ((snap.downFor ?? 0) > d.dropLongestS) return 'Longer than any drop so far.';
  if (d.dropsSession >= 2 && d.dropMedianS != null) {
    return `Drops here usually last ~${fmtDuration(d.dropMedianS)} (longest ${fmtDuration(d.dropLongestS)}).`;
  }
  return `Last drop here lasted ${fmtDuration(d.dropLongestS)}.`;
}

/**
 * The metric that binds a C/D grade: first of loss, rtt, p95, jitter to exceed the
 * next-better tier (§7.2), then the loss300 cap, then a failing verdict's reason.
 * Compares R/P95 with the satellite offset removed but prints absolute numbers (§7.1).
 */
export function bindingReason(snap: Snapshot): string {
  const tier = GRADE_TIERS[snap.grade.grade === 'D' ? 2 : 1];
  const off = snap.latencySource === 'http' ? 0 : snap.rttOffset; // §7.1 applies to ICMP only
  const { latencyMs: R, latencyP95: P, jitter: J, loss300 } = snap;
  const L = snap.lossGrade; // §7.2 grade input
  if (tier) {
    if (L != null && L > tier.loss) return `loss ${fmtPct(L)}`;
    if (R != null && R - off > tier.rtt) return `slow ${fmtSlow(R)}`;
    if (P != null && P - off > tier.p95) return `p95 ${fmtSlow(P)}`;
    if (J != null && J > tier.jitter) return `jitter ${fmtMsShort(J)}`;
  }
  if (loss300 != null && loss300 > CAP_LOSS300_PCT) return `loss ${fmtPct(loss300)} over 5m`;
  const v = snap.verdicts.find((x) => x.level !== 'OK' && x.reason !== '');
  return v ? primaryReason(v.reason) : 'poor link';
}

function levelWord(v: Verdict): string {
  return v.level === 'OK' ? 'OK' : v.level.toLowerCase();
}

function note(v: Verdict): string {
  const r = primaryReason(v.reason);
  return r === '' ? '' : ` (${r})`;
}

/** ` Video call shaky (…). Big downloads: no (…).` — only the activities that are not OK (§7.4). */
function activityNotes(snap: Snapshot): string {
  let s = '';
  for (const [name, label] of [['VIDEO CALL', 'Video call'], ['DOWNLOAD', 'Big downloads:']] as const) {
    const v = snap.verdicts.find((x) => x.name === name);
    if (v && v.level !== 'OK') s += ` ${label} ${levelWord(v)}${note(v)}.`;
  }
  return s;
}

/** UP/B-style sentence with video/download notes, or the A / C / D sentences. */
function gradedSentence(snap: Snapshot): string {
  const gr = snap.grade.grade;
  if (gr === 'C') return `Struggling (${bindingReason(snap)}). Chat works; pages will crawl. Skip calls.`;
  if (gr === 'D') return `Barely there (${bindingReason(snap)}). Only messaging is realistic right now.`;
  const notes = activityNotes(snap);
  // a grade-A link with a shaky activity (a recent drop) must not claim everything works
  if (gr === 'A') {
    return notes === '' ? 'Good connection. Calls, browsing and downloads should all work.' : `Good connection, but recent instability:${notes}`;
  }
  return `Fine for chat & browsing.${notes}`;
}

function signalNote(snap: Snapshot): string {
  const rssi = snap.wifi?.rssi;
  return rssi == null ? '' : ` (signal ${rssi} dBm)`;
}

function downSentence(snap: Snapshot, g: Glyphs): string {
  const e = expectation(snap);
  switch (snap.cause) {
    case 'router':
      return `Can't reach the router${signalNote(snap)}. Move the laptop or re-join Wi-Fi. ${e}`;
    case 'wifi':
      return `Wi-Fi link weak or lost${signalNote(snap)}. Move the laptop or re-join the network. ${e}`;
    default:
      return `Upstream link dropped ${g.em} router fine, it's not you. ${e}`;
  }
}

function noLinkSentence(snap: Snapshot): string {
  switch (snap.cause) {
    case 'not-joined': return 'Not joined to any Wi-Fi network. Join a Wi-Fi network from the menu bar.';
    case 'no-dhcp': return 'Joined Wi-Fi but got no address from the router (DHCP). Usually clears in ~30s; otherwise re-join.';
    default: return 'No network route. Check Wi-Fi in the menu bar.';
  }
}

function dnsSentence(snap: Snapshot, g: Glyphs): string {
  let s = `Pings work but names don't resolve ${g.em} browsing is broken.`;
  if (!snap.dnsSysOk && snap.dnsDirectOk) {
    const who = snap.dnsServer === TAILSCALE_DNS ? 'Tailscale' : 'the resolver';
    s += ` Direct DNS works: likely ${who}, not the network.`;
  }
  return s;
}

function webSentence(snap: Snapshot, g: Glyphs): string {
  const n = Math.max(3, snap.webFailStreak);
  return `Pings work but web requests fail (${n} in a row) ${g.em} a portal or proxy may be interfering.`;
}

/** Line 2 sentence chosen by state / cause / grade (§7.5 table). */
export function bannerSentence(snap: Snapshot, g: Glyphs = GLYPHS.unicode): string {
  switch (snap.state) {
    case 'WARMUP': return `Measuring${g.ellipsis} first verdict in a few seconds.`;
    case 'NO_LINK': return noLinkSentence(snap);
    case 'PORTAL': return `Captive portal wants a login. Press o to open the login page. ${expectation(snap)}`;
    case 'DOWN': return downSentence(snap, g);
    case 'DEGRADED':
      if (snap.cause === 'dns') return dnsSentence(snap, g);
      if (snap.cause === 'web') return webSentence(snap, g);
      return gradedSentence(snap);
    default: return gradedSentence(snap);
  }
}

/** §7.5: [line 1 segments joined, line 2 sentence]; untruncated. */
export function bannerLines(snap: Snapshot, g: Glyphs = GLYPHS.unicode): [string, string] {
  return [bannerSegments(snap, g).join(SEGMENT_SEP), bannerSentence(snap, g)];
}
