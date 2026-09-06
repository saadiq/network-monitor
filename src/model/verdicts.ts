// §7.4 activity verdicts. Pure: Snapshot fields in, four Verdicts out.
import { VERDICT } from '../config';
import { fmtAgo, fmtMbps, fmtMsShort, fmtPct } from '../core/format';
import { GLYPHS, type Glyphs } from '../ui/ansi';
import type { ActivityName, Cause, Grade, Snapshot, State, Verdict, VerdictLevel } from './types';
import { isOffline } from './types';

/** The Snapshot fields verdicts read (a full Snapshot is assignable). */
export type VerdictInputs = Pick<
  Snapshot,
  'state' | 'cause' | 'loss60' | 'lossGrade' | 'latencyMs' | 'latencySource' | 'rttOffset' | 'jitter'
  | 'grade' | 'drops' | 'dnsOk' | 'dnsSys' | 'http' | 'speed' | 'speedValid'
>;

export const REASON_MAX: number = VERDICT.reasonMax;

interface Ctx {
  state: State;
  cause: Cause;
  warm: boolean;
  offline: boolean;
  L: number | null; // effective loss60 %
  R: number | null; // p50 − rttOffset (comparisons)
  abs: number | null; // p50 as shown in reasons (§7.1 absolute numbers)
  J: number | null;
  grade: Grade; // held
  sinceDrop: number; // seconds; Infinity when no drops
  drops15: number;
  uptime15: number | null;
  dnsOk: boolean;
  dnsSysMs: number | null;
  httpMs: number | null;
  speed: number | null; // valid downMbps, else null (= "speed absent")
  g: Glyphs;
}

function ctxOf(s: VerdictInputs, g: Glyphs): Ctx {
  const speedOk = s.speedValid && s.speed !== null && s.speed.ok && s.speed.downMbps !== null;
  // §7.1 offset applies to ICMP RTT only; the HTTP proxy RTT is already a real transport RTT
  const rtt = s.latencyMs === null || s.latencySource === 'http' ? s.latencyMs : Math.max(0, s.latencyMs - s.rttOffset);
  return {
    state: s.state,
    cause: s.cause,
    warm: s.state === 'WARMUP',
    offline: isOffline(s.state),
    L: s.lossGrade, // §7.2 loss over the current steady run
    R: rtt,
    abs: s.latencyMs,
    J: s.jitter,
    grade: s.grade.grade,
    sinceDrop: s.drops.sinceLastDrop ?? Infinity,
    drops15: s.drops.drops15,
    uptime15: s.drops.uptime15,
    dnsOk: s.dnsOk,
    dnsSysMs: s.dnsSys?.ms ?? null,
    httpMs: s.http?.ms ?? null,
    speed: speedOk ? (s.speed as { downMbps: number }).downMbps : null,
    g,
  };
}

// ---- predicates (null = unknown = not a failure) ----------------------------------

function over(x: number | null, t: number): x is number {
  return x !== null && x > t;
}
function under(x: number | null, t: number): x is number {
  return x !== null && x < t;
}

// ---- reason strings (≤ 28 chars) ----------------------------------------------------

/** `1.8s` · `0.8s` · `12s` for the "slow"/"pages" reasons. */
function fmtSlow(ms: number): string {
  const v = Math.max(0, ms) / 1000;
  return v < 10 ? `${v.toFixed(1)}s` : `${Math.round(v)}s`;
}
const lossR = (l: number): string => `loss ${fmtPct(l)}`;
const jitterR = (j: number): string => `jitter ${fmtMsShort(j)}`;
const dropR = (s: number): string => `drop ${fmtAgo(s)}`;
const dropsR = (n: number): string => `${n} drops/15m`;
const downR = (mbps: number): string => `down ${fmtMbps(mbps)}`;
const offlineR = (c: Ctx): string => (c.state === 'PORTAL' ? 'portal login' : 'offline');
const JUST_BACK = 'just came back';

function clip(s: string): string {
  return Array.from(s).slice(0, REASON_MAX).join('');
}

function v(name: ActivityName, level: VerdictLevel, reason = ''): Verdict {
  return { name, level, reason: clip(reason) };
}

/** Why a non-UP graded state (DEGRADED) fails an OK rule. */
function degradedR(c: Ctx): string {
  if (c.cause === 'dns') return 'DNS failing';
  if (c.cause === 'web') return 'web failing';
  if (c.grade === null) return 'no grade yet';
  // the grade already recovered; the state follows after the §6.3 debounce
  if (c.cause === 'quality' && (c.grade === 'A' || c.grade === 'B')) return 'recovering';
  return `grade ${c.grade}`;
}

// ---- CHAT ---------------------------------------------------------------------------

function chat(c: Ctx): Verdict {
  const name: ActivityName = 'CHAT';
  if (c.warm) return v(name, '?');
  if (c.offline) return v(name, 'NO', offlineR(c));
  if (over(c.L, VERDICT.chat.loss)) return v(name, 'SHAKY', lossR(c.L));
  if (over(c.R, VERDICT.chat.rtt)) return v(name, 'SHAKY', `slow ${fmtSlow(c.abs ?? c.R)}`);
  if (c.sinceDrop < VERDICT.justBackS) return v(name, 'SHAKY', JUST_BACK);
  return v(name, 'OK');
}

// ---- BROWSE -------------------------------------------------------------------------

function browse(c: Ctx): Verdict {
  const name: ActivityName = 'BROWSE';
  const t = VERDICT.browse;
  if (c.warm) return v(name, '?');
  if (c.offline) return v(name, 'NO', offlineR(c));
  if (!c.dnsOk) return v(name, 'NO', 'DNS failing');
  if (c.cause === 'web') return v(name, 'NO', 'web failing'); // §6.2 row 8: pages are what fails
  if (c.grade === 'D') return v(name, 'SHAKY', 'grade D');
  if (over(c.L, t.loss)) return v(name, 'SHAKY', lossR(c.L));
  if (over(c.R, t.rtt)) return v(name, 'SHAKY', `slow ${fmtSlow(c.abs ?? c.R)}`);
  if (over(c.httpMs, t.httpMs)) return v(name, 'SHAKY', `pages ${fmtSlow(c.httpMs)}`);
  if (over(c.dnsSysMs, t.dnsSysMs)) return v(name, 'SHAKY', `DNS ${fmtMsShort(c.dnsSysMs)}`);
  if (c.sinceDrop < VERDICT.justBackS) return v(name, 'SHAKY', JUST_BACK);
  return v(name, 'OK');
}

// ---- VIDEO CALL ---------------------------------------------------------------------

/** First failed OK rule (§7.4 VIDEO), or null when all pass. */
function videoOkFail(c: Ctx): string | null {
  const t = VERDICT.video.ok;
  if (c.state !== 'UP') return degradedR(c);
  if (c.grade !== 'A' && c.grade !== 'B') return c.grade === null ? 'no grade yet' : `grade ${c.grade}`;
  if (over(c.L, t.loss)) return lossR(c.L);
  if (over(c.J, t.jitter)) return jitterR(c.J);
  if (over(c.R, t.rtt)) return `slow ${fmtMsShort(c.abs ?? c.R)}`;
  if (c.sinceDrop < t.sinceDropS) return dropR(c.sinceDrop);
  if (c.drops15 > t.drops15) return dropsR(c.drops15);
  if (under(c.speed, t.minMbps)) return downR(c.speed);
  return null;
}

/** First failed SHAKY rule, or null when all pass (state is UP/DEGRADED here). */
function videoShakyFail(c: Ctx): string | null {
  const t = VERDICT.video.shaky;
  if (over(c.L, t.loss)) return lossR(c.L);
  if (over(c.J, t.jitter)) return jitterR(c.J);
  if (over(c.R, t.rtt)) return `slow ${fmtMsShort(c.abs ?? c.R)}`;
  if (c.sinceDrop < t.sinceDropS) return dropR(c.sinceDrop);
  return null;
}

function video(c: Ctx): Verdict {
  const name: ActivityName = 'VIDEO CALL';
  if (c.warm) return v(name, '?');
  if (c.offline) return v(name, 'NO', offlineR(c));
  const okFail = videoOkFail(c);
  if (okFail === null) return v(name, 'OK');
  const shakyFail = videoShakyFail(c);
  if (shakyFail !== null) return v(name, 'NO', shakyFail);
  const a = VERDICT.video.audioOk;
  const audio = !over(c.L, a.loss) && !over(c.J, a.jitter);
  return v(name, 'SHAKY', audio ? `${okFail} ${c.g.sep} audio ok` : okFail);
}

// ---- DOWNLOAD -----------------------------------------------------------------------

function download(c: Ctx): Verdict {
  const name: ActivityName = 'DOWNLOAD';
  const t = VERDICT.download;
  if (c.warm) return v(name, '?');
  if (c.offline) return v(name, 'NO', offlineR(c));
  // drops15 ≤ 2 added so OK ⊂ SHAKY (spec omits it; mockup shows NO "3 drops/15m").
  const ok =
    c.state === 'UP' && c.grade !== null && c.grade !== 'D' && !under(c.uptime15, t.ok.uptime15)
    && c.sinceDrop >= t.ok.sinceDropS && c.drops15 <= t.shaky.drops15 && !under(c.speed, t.ok.minMbps);
  if (ok) return v(name, 'OK', c.speed === null ? 'untested (t)' : `${c.g.dl}${fmtMbps(c.speed)}`);
  if (!under(c.uptime15, t.shaky.uptime15) && c.drops15 <= t.shaky.drops15) {
    if (c.sinceDrop < t.ok.sinceDropS) return v(name, 'SHAKY', dropR(c.sinceDrop));
    if (under(c.speed, t.ok.minMbps)) return v(name, 'SHAKY', downR(c.speed));
    return v(name, 'SHAKY', 'use curl -C - (resumable)');
  }
  if (c.drops15 > t.shaky.drops15) return v(name, 'NO', dropsR(c.drops15));
  if (c.uptime15 !== null) return v(name, 'NO', `uptime ${fmtPct(c.uptime15)}`);
  return v(name, 'NO', 'unstable');
}

/** §7.4: CHAT, BROWSE, VIDEO CALL, DOWNLOAD in that order. */
export function activityVerdicts(snap: VerdictInputs, g: Glyphs = GLYPHS.unicode): Verdict[] {
  const c = ctxOf(snap, g);
  return [chat(c), browse(c), video(c), download(c)];
}
