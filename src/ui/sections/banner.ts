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

/** `● UP · OK (B)` / `● DOWN · uplink` / `● DEGRADED · dns · OK (B)`. */
function headSegment(snap: Snapshot, g: Glyphs, on: boolean): string {
  let s = paint(stateColor(snap.state), `${g.bullet} ${stateWord(snap.state)}`, on);
  const cause = causeLabel(snap);
  if (cause) s += ` ${g.sep} ${cause}`;
  const gr = snap.grade.grade;
  if (gr && (snap.state === 'UP' || snap.state === 'DEGRADED')) {
    const tilde = snap.grade.underLoad ? '~' : ''; // §4.8
    s += ` ${g.sep} ` + paint(gradeColor(gr), `${GRADE_WORDS[gr]} (${gr}${tilde})`, on);
  }
  return s;
}

/** §7.5 line 1 segments in order. */
export function bannerSegments(snap: Snapshot, g: Glyphs, on: boolean): string[] {
  const segs = [headSegment(snap, g, on)];
  if (snap.state === 'UP' || snap.state === 'DEGRADED') {
    segs.push(`steady ${fmtDuration(snap.steadyFor)}`);
  } else if (isOffline(snap.state)) {
    const secs = snap.downFor ?? (snap.now - snap.since) / 1000;
    segs.push(paint(stateColor(snap.state), `${stateWord(snap.state)} ${fmtClock(secs)}`, on));
  }
  const t = snap.trend;
  if (t.phrase && t.overall) {
    const worse = t.overall === 'worse';
    segs.push(paint(worse ? 'yellow' : 'green', `${t.phrase} ${worse ? g.up : g.down}`, on));
  }
  const n = snap.drops.drops15;
  if (n > 0) segs.push(`${n} drop${n === 1 ? '' : 's'} in 15m`);
  if (snap.grade.tags.includes('FLAKY')) segs.push(paint('yellow', 'FLAKY', on));
  if (snap.sat) segs.push(`sat +${snap.rttOffset}ms`);
  if (snap.grade.underLoad) segs.push('~ under load');
  return segs;
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
