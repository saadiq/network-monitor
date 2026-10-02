// Simple-view status block (simple-view spec §4): a colored state badge, then grade / timer / trend
// segments shed from the right, then the §7.5 sentence. Inverse for FLASH_TICKS after a transition. Pure.
import { fit } from '../../core/format';
import type { Snapshot, UiState } from '../../model/types';
import { color, type Glyphs } from '../ansi';
import { causeLabel, flagSegments, gradeSegment, timerSegment, trendSegment } from './banner';
import { LEAD, ellipsize, paint, shedRight, stateColor, stateWord } from './common';

const GAP = '   ';

/** ` UP ` as a bold block in the state color (inverse); `● UP` without color. */
function badge(snap: Snapshot, g: Glyphs, on: boolean, flash: boolean): string {
  const word = stateWord(snap.state);
  if (!on) return `${g.bullet} ${word}`;
  const c = stateColor(snap.state);
  const block = paint(c, ` ${word} `, on);
  const text = c === 'dim' ? block : color('bold', block, on); // bold and dim share their off code
  return flash ? text : color('inverse', text, on); // a flashing row is already inverse
}

/** Row-1 segments in shedding order (the badge is never shed); the §7.5 parts come from banner.ts. */
function statusSegments(snap: Snapshot, g: Glyphs, on: boolean, flash: boolean): string[] {
  return [
    badge(snap, g, on, flash), causeLabel(snap), gradeSegment(snap, on), timerSegment(snap, on),
    trendSegment(snap, g, on), ...flagSegments(snap, on),
  ].filter((x): x is string => x !== null);
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
