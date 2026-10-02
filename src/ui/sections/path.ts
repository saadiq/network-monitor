// §8.1 hop chain: `PATH  Wi-Fi ✔ -72dBm → Router ✔ 7ms → Internet ✔ 48ms → DNS ✔ 31ms (sys 380) → Web ✔ 200 OK`.
// Compact drops the detail of healthy hops (`Wi-Fi ✔ → Router ✔ → … → Web ✔`); failures keep theirs.
// The hop model lives in hops.ts (shared with the simple view's chain).
import { fit, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import { GLYPHS, type Glyphs } from '../ansi';
import { LEAD, markColor, markGlyph, paint, shedRight, type SectionPlan } from './common';
import { hopDetail, hopList, type Detail, type Hop } from './hops';

/** path() steps down this ladder until the row fits (never truncates a hop). */
const LADDER: Readonly<Record<'full' | 'compact', readonly Detail[]>> = {
  full: ['full', 'compact', 'short', 'abbrev'],
  compact: ['compact', 'short', 'abbrev'],
};

function renderHop(h: Hop, level: Detail, g: Glyphs, on: boolean): string {
  const mark = paint(h.color ?? markColor(h.mark), markGlyph(h.mark, g), on);
  const name = level === 'abbrev' ? h.abbr ?? h.name : h.name;
  const detail = hopDetail(h, level);
  return `${name} ${mark}${detail ? ` ${detail}` : ''}`;
}

/** Last resort: as many whole hops as fit, so the row never ends on a dangling arrow. */
function keepWholeHops(parts: string[], head: string, sep: string, w: number): string {
  return fit(head + shedRight(parts, sep, w - visibleWidth(head)), w);
}

/** One row, exactly `plan.cols` cells; hop detail is shed before anything is cut. */
export function path(snap: Snapshot, plan: SectionPlan, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const hops = hopList(snap, g);
  const head = `${LEAD}PATH  `;
  const sep = ` ${g.arrow} `;
  let parts: string[] = [];
  for (const level of LADDER[plan.compact ? 'compact' : 'full']) {
    parts = hops.map((h) => renderHop(h, level, g, colorOn));
    const line = head + parts.join(sep);
    if (visibleWidth(line) <= plan.cols) return [fit(line, plan.cols)];
  }
  return [keepWholeHops(parts, head, sep, plan.cols)];
}
