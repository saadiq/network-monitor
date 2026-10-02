// §8.1 rows 3–4: state line + one-sentence verdict (§7.5), inverse for FLASH_TICKS after a transition.
import { FULL_COLS, GRADE_WORDS } from '../../config';
import { fit, fmtClock, fmtDuration } from '../../core/format';
import { isOffline, type Snapshot, type UiState } from '../../model/types';
import { GLYPHS, color, type Glyphs } from '../ansi';
import { LEAD, gradeColor, paint, stateColor, stateWord } from './common';

/** Second token after the state word for non-graded causes (`DOWN · uplink`). */
export function causeLabel(snap: Snapshot): string | null {
  switch (snap.cause) {
    case 'uplink': case 'router': case 'dns': case 'web': return snap.cause;
    case 'wifi': return 'wi-fi';
    case 'not-joined': return 'not joined';
    case 'no-dhcp': return 'no DHCP';
    case 'unknown': return snap.state === 'NO_LINK' ? 'no route' : null;
    default: return null; // portal (redundant with PORTAL), quality (grade shown), null
  }
}

const graded = (snap: Snapshot): boolean => snap.state === 'UP' || snap.state === 'DEGRADED';

/** `OK (B)` (`OK (B~)` under load, §4.8) in the grade color; null outside UP/DEGRADED. */
export function gradeSegment(snap: Snapshot, on: boolean): string | null {
  const gr = snap.grade.grade;
  if (!gr || !graded(snap)) return null;
  const tilde = snap.grade.underLoad ? '~' : '';
  return paint(gradeColor(gr), `${GRADE_WORDS[gr]} (${gr}${tilde})`, on);
}

/** `steady 4m12s` in UP/DEGRADED, the `DOWN 0:42` clock while offline, else null. */
export function timerSegment(snap: Snapshot, on: boolean): string | null {
  if (graded(snap)) return `steady ${fmtDuration(snap.steadyFor)}`;
  if (!isOffline(snap.state)) return null;
  const secs = snap.downFor ?? (snap.now - snap.since) / 1000;
  return paint(stateColor(snap.state), `${stateWord(snap.state)} ${fmtClock(secs)}`, on);
}

/** `getting worse ▲` (yellow) / `getting better ▼` (green), or null. */
export function trendSegment(snap: Snapshot, g: Glyphs, on: boolean): string | null {
  const t = snap.trend;
  if (!t.phrase || !t.overall) return null;
  const worse = t.overall === 'worse';
  return paint(worse ? 'yellow' : 'green', `${t.phrase} ${worse ? g.up : g.down}`, on);
}

/** Trailing qualifiers: FLAKY, satellite offset, under load. */
export function flagSegments(snap: Snapshot, on: boolean): string[] {
  const segs: string[] = [];
  if (snap.grade.tags.includes('FLAKY')) segs.push(paint('yellow', 'FLAKY', on));
  if (snap.sat) segs.push(`sat +${snap.rttOffset}ms`);
  if (snap.grade.underLoad) segs.push('~ under load');
  return segs;
}

/** `● UP · OK (B)` / `● DOWN · uplink` / `● DEGRADED · dns · OK (B)`. */
function headSegment(snap: Snapshot, g: Glyphs, on: boolean): string {
  const state = paint(stateColor(snap.state), `${g.bullet} ${stateWord(snap.state)}`, on);
  return [state, causeLabel(snap), gradeSegment(snap, on)].filter((s) => s !== null).join(` ${g.sep} `);
}

/** §7.5 line 1 segments in order. */
export function bannerSegments(snap: Snapshot, g: Glyphs, on: boolean): string[] {
  const n = snap.drops.drops15;
  const drops = n > 0 ? `${n} drop${n === 1 ? '' : 's'} in 15m` : null;
  return [headSegment(snap, g, on), timerSegment(snap, on), trendSegment(snap, g, on), drops, ...flagSegments(snap, on)]
    .filter((s): s is string => s !== null);
}

/** Two rows, exactly `w` cells each. */
export function banner(
  snap: Snapshot, ui: UiState, w: number, g: Glyphs = GLYPHS.unicode, colorOn = true,
): string[] {
  const gap = ' '.repeat(w >= FULL_COLS ? 6 : 5);
  const rows = [LEAD + bannerSegments(snap, g, colorOn).join(gap), LEAD + snap.banner[1]];
  const flash = ui.flashTicksLeft > 0;
  return rows.map((s) => (flash ? color('inverse', fit(s, w), colorOn) : fit(s, w)));
}
