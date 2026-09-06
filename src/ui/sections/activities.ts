// §8.1 activity strip: `CHAT ✔ OK    BROWSE ✔ OK    VIDEO ~ SHAKY jitter 71ms · audio ok    DOWNLOAD ✘ NO …`.
// One row at ≥ FULL_COLS; below that two rows, items wrapped greedily (§8.2 mockup: 3 + 1).
import { FULL_COLS } from '../../config';
import { fit, truncate, visibleWidth } from '../../core/format';
import type { ActivityName, Snapshot, Verdict } from '../../model/types';
import { GLYPHS, type Glyphs } from '../ansi';
import { LEAD, levelMark, markColor, markGlyph, paint, type SectionPlan } from './common';

const ORDER: readonly ActivityName[] = ['CHAT', 'BROWSE', 'VIDEO CALL', 'DOWNLOAD'];
const LABEL: Readonly<Record<ActivityName, string>> = {
  CHAT: 'CHAT', BROWSE: 'BROWSE', 'VIDEO CALL': 'VIDEO', DOWNLOAD: 'DOWNLOAD',
};
const SEP = '    ';
const MIN_REASON = 8; // a shorter cut reason says nothing, so it is dropped instead

/** `CHAT ✔ OK` and its §7.4 reason, kept apart so only the reason is ever shortened. */
interface Item { head: string; reason: string }

function item(v: Verdict, g: Glyphs, on: boolean): Item {
  const m = levelMark(v.level);
  const mark = paint(markColor(m), markGlyph(m, g), on);
  const level = v.level === '?' ? '' : ` ${v.level}`; // `CHAT ?` in WARMUP
  return { head: `${LABEL[v.name]} ${mark}${level}`, reason: v.reason };
}

function items(snap: Snapshot, g: Glyphs, on: boolean): Item[] {
  return ORDER.map((name) => {
    const v = snap.verdicts.find((x) => x.name === name) ?? { name, level: '?' as const, reason: '' };
    return item(v, g, on);
  });
}

function width(it: Item): number {
  return visibleWidth(it.head) + (it.reason ? 1 + visibleWidth(it.reason) : 0);
}

/**
 * One row, exactly w cells. Every name, mark and level is kept: the reasons are spent
 * left to right on what is left of the row, and the first one that no longer fits whole is
 * cut with an ellipsis (or dropped when too little room remains).
 */
function row(list: Item[], w: number, g: Glyphs): string {
  const seps = SEP.length * Math.max(0, list.length - 1);
  let room = w - LEAD.length - seps - list.reduce((n, it) => n + visibleWidth(it.head), 0);
  const parts = list.map((it) => {
    if (!it.reason) return it.head;
    const need = width(it) - visibleWidth(it.head);
    if (need <= room) {
      room -= need;
      return `${it.head} ${it.reason}`;
    }
    if (room < MIN_REASON) return it.head;
    const cut = truncate(it.reason, room - 1 - visibleWidth(g.ellipsis)) + g.ellipsis;
    room -= 1 + visibleWidth(cut);
    return `${it.head} ${cut}`;
  });
  return fit(LEAD + parts.join(SEP), w);
}

/** Greedy wrap onto two rows: fill row 1 while items fit, the rest go to row 2. */
function wrap(list: Item[], w: number): [Item[], Item[]] {
  const a: Item[] = [];
  const b: Item[] = [];
  let used = LEAD.length;
  for (const it of list) {
    const add = a.length ? SEP.length + width(it) : width(it);
    if (b.length === 0 && (a.length === 0 || used + add <= w)) {
      a.push(it);
      used += add;
    } else {
      b.push(it);
    }
  }
  return [a, b];
}

/** 1 row at ≥ 100 cols, else 2 rows; every row exactly `plan.cols` cells. */
export function activities(
  snap: Snapshot, plan: SectionPlan, g: Glyphs = GLYPHS.unicode, colorOn = true,
): string[] {
  const w = plan.cols;
  const list = items(snap, g, colorOn);
  if (w >= FULL_COLS) return [row(list, w, g)];
  const [a, b] = wrap(list, w);
  return [row(a, w, g), row(b, w, g)];
}
