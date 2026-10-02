// Simple-view hop chain (simple-view spec §4): `Wi-Fi ●──── Router ●──── Internet ● no reply 42s ──── DNS ●`.
// Same hops as the §8.1 PATH row; colored dots carry the status, mark glyphs replace them without color. Pure.
import { fit, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, markColor, markGlyph, paint } from './common';
import { hopDetail, hopList, type Hop } from './hops';

interface Rung { dashes: number; space: boolean; detail: boolean; abbrev: boolean }

/** Tried in order until the row fits (simple-view spec §4 width ladder). */
const LADDER: readonly Rung[] = [
  { dashes: 4, space: true, detail: true, abbrev: false },
  { dashes: 3, space: true, detail: true, abbrev: false },
  { dashes: 2, space: true, detail: true, abbrev: false },
  { dashes: 1, space: true, detail: true, abbrev: false },
  { dashes: 1, space: false, detail: true, abbrev: false },
  { dashes: 1, space: false, detail: false, abbrev: false },
  { dashes: 1, space: false, detail: false, abbrev: true },
];

const isBad = (h: Hop): boolean => h.mark === 'fail' || h.mark === 'shaky';

function node(h: Hop, detail: string, abbrev: boolean, g: Glyphs, on: boolean): string {
  const c = h.color ?? markColor(h.mark);
  const dot = on ? paint(c, g.dot, on) : markGlyph(h.mark, g);
  const name = abbrev ? h.abbr ?? h.name : h.name;
  return `${name} ${dot}${detail ? ' ' + paint(c, detail, on) : ''}`;
}

function render(hops: Hop[], bad: number, r: Rung, g: Glyphs, on: boolean): string {
  const details = hops.map((h, i) => (r.detail && i === bad ? hopDetail(h, 'compact') : ''));
  let out = LEAD;
  hops.forEach((h, i) => {
    if (i > 0) {
      const afterDetail = (details[i - 1] ?? '') !== '';
      out += paint('dim', (afterDetail ? ' ' : '') + g.link.repeat(r.dashes) + (r.space ? ' ' : ''), on);
    }
    out += node(h, details[i] ?? '', r.abbrev, g, on);
  });
  return out;
}

/** One row, exactly `w` cells. */
export function chain(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const hops = hopList(snap, g);
  const bad = hops.findIndex(isBad);
  let line = LEAD;
  for (const r of LADDER) {
    line = render(hops, bad, r, g, on);
    if (visibleWidth(line) <= w) break;
  }
  return [fit(line, w)];
}
