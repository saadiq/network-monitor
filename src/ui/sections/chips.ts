// Simple-view activity chips (simple-view spec §4): `✔ Chat  ✔ Browse  ~ Video call  ✘ Download` in the
// verdict colors, the binding reason (dim) under each non-OK chip; a 2×2 grid in narrow panes. Pure.
import { CHIPS_GRID_COLS } from '../../config';
import { fit, padEnd, visibleWidth } from '../../core/format';
import type { ActivityName, Snapshot, Verdict } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, ellipsize, levelMark, markColor, markGlyph, paint } from './common';

/** Full and short chip names; the short one is used when a full chip would not fit its column. */
const NAMES: Readonly<Record<ActivityName, readonly [full: string, short: string]>> = {
  CHAT: ['Chat', 'Chat'], BROWSE: ['Browse', 'Browse'], 'VIDEO CALL': ['Video call', 'Video'], DOWNLOAD: ['Download', 'Download'],
};

/** `✔ Chat`, uncolored. */
function chipText(v: Verdict, short: boolean, g: Glyphs): string {
  const [full, abbr] = NAMES[v.name];
  return `${markGlyph(levelMark(v.level), g)} ${short ? abbr : full}`;
}

function chip(v: Verdict, short: boolean, g: Glyphs, on: boolean): string {
  return paint(markColor(levelMark(v.level)), chipText(v, short, g), on);
}

/** The reason cut at the last ` · ` (g.sep) that fits in w, else ellipsized. */
export function cutReason(reason: string, w: number, g: Glyphs): string {
  if (visibleWidth(reason) <= w) return reason;
  const sep = ` ${g.sep} `;
  const parts = reason.split(sep);
  for (let n = parts.length - 1; n >= 1; n--) {
    const s = parts.slice(0, n).join(sep);
    if (visibleWidth(s) <= w) return s;
  }
  return ellipsize(reason, w, g);
}

function grid(vs: Verdict[], w: number, g: Glyphs, on: boolean): string[] {
  const col = Math.floor((w - LEAD.length) / 2);
  const row = (a?: Verdict, b?: Verdict): string =>
    fit(LEAD + (a ? padEnd(chip(a, false, g, on), col) : '') + (b ? chip(b, false, g, on) : ''), w);
  return [row(vs[0], vs[1]), row(vs[2], vs[3])];
}

/** Two rows, exactly `w` cells each. */
export function chips(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const vs = snap.verdicts;
  if (w < CHIPS_GRID_COLS) return grid(vs, w, g, on);
  const col = Math.floor((w - LEAD.length) / 4);
  const short = vs.some((v) => visibleWidth(chipText(v, false, g)) > col - 1);
  let top = LEAD;
  let under = LEAD;
  for (const v of vs) {
    top += padEnd(chip(v, short, g, on), col);
    const reason = v.level === 'OK' || !v.reason ? '' : paint('dim', cutReason(v.reason, col - 1, g), on);
    under += padEnd(reason, col);
  }
  return [fit(top, w), fit(under, w)];
}
