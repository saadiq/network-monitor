// Simple-view status block (simple-view spec §4): a colored state badge, then grade / timer / trend
// segments shed from the right, then the §7.5 sentence. Inverse for FLASH_TICKS after a transition. Pure.
import { GRADE_WORDS } from '../../config';
import { fit, fmtClock, fmtDuration } from '../../core/format';
import { isOffline, type Snapshot, type UiState } from '../../model/types';
import { color, type Glyphs } from '../ansi';
import { causeLabel } from './banner';
import { LEAD, ellipsize, gradeColor, paint, shedRight, stateColor, stateWord } from './common';

const GAP = '   ';

/** ` UP ` as a bold block in the state color (inverse); `● UP` without color. */
export function badge(snap: Snapshot, g: Glyphs, on: boolean, flash: boolean): string {
  const word = stateWord(snap.state);
  if (!on) return `${g.bullet} ${word}`;
  const text = color('bold', paint(stateColor(snap.state), ` ${word} `, on), on);
  return flash ? text : color('inverse', text, on); // a flashing row is already inverse
}

/** Row-1 segments in shedding order; the badge is never shed. */
export function statusSegments(snap: Snapshot, g: Glyphs, on: boolean, flash = false): string[] {
  const segs = [badge(snap, g, on, flash)];
  const cause = causeLabel(snap);
  if (cause) segs.push(cause);
  const graded = snap.state === 'UP' || snap.state === 'DEGRADED';
  const gr = snap.grade.grade;
  if (gr && graded) {
    const tilde = snap.grade.underLoad ? '~' : ''; // §4.8
    segs.push(paint(gradeColor(gr), `${GRADE_WORDS[gr]} (${gr}${tilde})`, on));
  }
  if (graded) {
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
  if (snap.grade.tags.includes('FLAKY')) segs.push(paint('yellow', 'FLAKY', on));
  if (snap.sat) segs.push(`sat +${snap.rttOffset}ms`);
  if (snap.grade.underLoad) segs.push('~ under load');
  return segs;
}

/** Two rows, exactly `w` cells each. */
export function status(snap: Snapshot, ui: UiState, w: number, g: Glyphs, on: boolean): string[] {
  const flash = ui.flashTicksLeft > 0;
  const room = w - LEAD.length;
  const rows = [
    LEAD + shedRight(statusSegments(snap, g, on, flash), GAP, room),
    LEAD + ellipsize(snap.banner[1], room, g),
  ];
  return rows.map((s) => (flash ? color('inverse', fit(s, w), on) : fit(s, w)));
}
