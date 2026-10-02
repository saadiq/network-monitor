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

/**
 * The row for one ladder rung, stopping before the first hop that would overflow `w` (so a hop is
 * never cut through its mark); `detail` belongs to hop `bad`.
 */
function render(hops: Hop[], bad: number, detail: string, r: Rung, g: Glyphs, on: boolean, w: number): { line: string; whole: boolean } {
  const shown = r.detail ? detail : '';
  let out = LEAD;
  for (const [i, h] of hops.entries()) {
    const lead = i - 1 === bad && shown !== '' ? ' ' : '';
    const link = i === 0 ? '' : paint('dim', lead + g.link.repeat(r.dashes) + (r.space ? ' ' : ''), on);
    const next = out + link + node(h, i === bad ? shown : '', r.abbrev, g, on);
    if (visibleWidth(next) > w) return { line: out, whole: false };
    out = next;
  }
  return { line: out, whole: true };
}

/** The hop whose detail is shown: the first failing/shaky one, else the first other non-ok hop with a reason. */
function detailHop(hops: Hop[]): number {
  const failing = hops.findIndex(isBad);
  return failing >= 0 ? failing : hops.findIndex((h) => h.mark !== 'ok' && hopDetail(h, 'compact') !== '');
}

/** One row, exactly `w` cells. */
export function chain(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const hops = hopList(snap, g);
  const bad = detailHop(hops);
  const badHop = hops[bad];
  const detail = badHop ? hopDetail(badHop, 'compact') : '';
  let line = LEAD;
  for (const r of LADDER) {
    const res = render(hops, bad, detail, r, g, on, w);
    line = res.line;
    if (res.whole) break;
  }
  return [fit(line, w)];
}
