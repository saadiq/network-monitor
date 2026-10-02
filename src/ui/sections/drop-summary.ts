// Simple-view drop summary under the timeline (simple-view spec §4):
// `3 drops · usually ~22s · longest 1m04s · last 4m ago`, segments shed from the right. Pure.
import { fit, fmtAgo, fmtDuration } from '../../core/format';
import type { Snapshot } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, paint, shedRight } from './common';

/** The summary's segments for this snapshot (empty during an outage with no history). */
function dropSegments(snap: Snapshot, on: boolean): string[] {
  const d = snap.drops;
  const usually = d.dropMedianS == null ? null : `usually ~${fmtDuration(d.dropMedianS)}`;
  const longest = d.dropLongestS == null ? null : `longest ${fmtDuration(d.dropLongestS)}`;
  const last = d.sinceLastDrop == null ? null : `last ${fmtAgo(d.sinceLastDrop)}`;
  let segs: (string | null)[];
  if (snap.openOutage) {
    segs = d.dropMedianS == null ? [] : [`drops here usually last ~${fmtDuration(d.dropMedianS)}`, longest];
  } else if (d.dropsSession === 0) {
    segs = [paint('green', 'no drops', on)];
  } else if (d.drops15 === 0) {
    segs = [paint('green', 'no drops in 15m', on), last];
  } else {
    segs = [`${d.drops15} drop${d.drops15 === 1 ? '' : 's'}`, usually, longest, last];
  }
  return segs.filter((s): s is string => s !== null);
}

/** One row, exactly `w` cells (blank when there is nothing to say). */
export function dropSummary(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const segs = dropSegments(snap, on);
  return [fit(segs.length ? LEAD + shedRight(segs, ` ${g.sep} `, w - LEAD.length) : '', w)];
}
