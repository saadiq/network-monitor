// Simple-view latency chart (simple-view spec §4): a caption row, then a linear bar chart of the last
// 60 internet RTT samples, newest at the right, each bar colored by its §7.2 tier band. Pure.
import { GRADE_TIERS } from '../../config';
import { fit, fmtMs, padStart, visibleWidth } from '../../core/format';
import type { Snapshot, UiState } from '../../model/types';
import type { ColorName, Glyphs } from '../ansi';
import { LEAD, paint, paintRuns } from './common';
import { speedText } from './metrics-cells';

const MIN_SAMPLES = 3; // fewer → "measuring…"
const WIDE_PLOT = 120; // plot width at which each sample gets two columns
const GREEN_MAX = GRADE_TIERS[1]?.rtt ?? 300; // tier B
const YELLOW_MAX = GRADE_TIERS[2]?.rtt ?? 800; // tier C

/** Smallest of 50, 100, 200, 500, 1000, 2000, 5000, … that is ≥ max. */
export function niceTop(max: number): number {
  if (!Number.isFinite(max)) return 50;
  for (let e = 1; e < 12; e++) {
    for (const k of [1, 2, 5]) {
      const t = k * 10 ** e;
      if (t >= 50 && t >= max) return t;
    }
  }
  return 10 ** 12;
}

/** Bar height in eighths of a row: at least 1 for any reply, at most rows × 8. */
export function barEighths(v: number, rows: number, top: number): number {
  const total = rows * 8;
  if (!(v > 0) || top <= 0) return 0;
  return Math.max(1, Math.min(total, Math.round((total * v) / top)));
}

/** §7.2 tier band of one sample, satellite offset removed. */
export function barColor(v: number, offset: number): ColorName {
  const r = v - offset;
  return r <= GREEN_MAX ? 'green' : r <= YELLOW_MAX ? 'yellow' : 'red';
}

/** Glyph for plot row `fromBottom` (0 = bottom) of a bar `e` eighths tall. */
function barCell(e: number, fromBottom: number, g: Glyphs): string {
  const fill = Math.max(0, Math.min(8, e - fromBottom * 8));
  if (fill === 0) return ' ';
  return fill === 8 ? g.full : g.eighths[fill - 1] ?? g.full;
}

interface Plot { axisW: number; top: number; per: number; shown: (number | null)[] }

function geometry(snap: Snapshot, cols: number): Plot {
  const nums = snap.rttHistory.filter((v): v is number => v != null && Number.isFinite(v));
  const top = niceTop(nums.length ? Math.max(...nums) : 0);
  const axisW = String(top).length + 1;
  const width = Math.max(0, cols - LEAD.length - axisW);
  const per = width >= WIDE_PLOT ? 2 : 1;
  const n = Math.floor(width / per);
  return { axisW, top, per, shown: n > 0 ? snap.rttHistory.slice(-n) : [] };
}

function axisLabel(r: number, rows: number, p: Plot, g: Glyphs, on: boolean): string {
  const mid = Math.round(rows / 2);
  let label = '';
  if (r === 0) label = String(p.top);
  else if (rows >= 4 && r === mid) label = String(Math.round((p.top * (rows - r)) / rows));
  return paint('dim', padStart(label, p.axisW - 1) + g.axis, on);
}

function plotRows(snap: Snapshot, p: Plot, rows: number, g: Glyphs, on: boolean): string[] {
  const bars = p.shown.map((v) => (v == null ? null : { e: barEighths(v, rows, p.top), c: barColor(v, snap.rttOffset) }));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const fromBottom = rows - 1 - r;
    const chars: string[] = [];
    const colors: (ColorName | null)[] = [];
    for (const b of bars) {
      const ch = b ? barCell(b.e, fromBottom, g) : fromBottom === 0 ? g.lost : ' ';
      const c: ColorName = b ? b.c : 'red';
      for (let k = 0; k < p.per; k++) {
        chars.push(ch);
        colors.push(ch === ' ' ? null : c);
      }
    }
    out.push(LEAD + axisLabel(r, rows, p, g, on) + paintRuns(chars, colors, on));
  }
  return out;
}

function captionLeft(snap: Snapshot, g: Glyphs): string {
  if (snap.icmpBlocked) {
    return snap.rttProxyMs == null
      ? 'LATENCY  ping blocked'
      : `LATENCY  ${fmtMs(snap.rttProxyMs)}ms via web checks (ping blocked)`;
  }
  if (snap.rttHistory.length < MIN_SAMPLES) return `LATENCY  measuring${g.ellipsis}`;
  if (snap.latencyMs == null) return 'LATENCY  no replies';
  let s = `LATENCY  ${fmtMs(snap.latencyMs)}ms typical`;
  if (snap.latencyP95 != null) s += ` ${g.sep} ${fmtMs(snap.latencyP95)}ms peaks`;
  if (snap.sat) s += ` ${g.sep} satellite`;
  return s;
}

function captionRight(snap: Snapshot, ui: UiState, shown: number, g: Glyphs): string {
  if (ui.speedRunning) return `speed test running${g.ellipsis}`;
  if (snap.speed) return `speed ${speedText(snap, g)}`;
  return shown > 0 ? `last ${shown}s` : '';
}

/** Caption row: left text, right text right-aligned (dropped when it does not fit). */
function caption(left: string, right: string, w: number, on: boolean): string {
  const gap = w - visibleWidth(left) - visibleWidth(right);
  if (!right || gap < 2) return fit(left, w);
  return fit(left + ' '.repeat(gap) + paint('dim', right, on), w);
}

/** `rows` lines (caption + plot rows), exactly `cols` cells each. */
export function chart(snap: Snapshot, ui: UiState, cols: number, rows: number, g: Glyphs, on: boolean): string[] {
  if (rows <= 0) return [];
  const p = geometry(snap, cols);
  const plotting = !snap.icmpBlocked && snap.rttHistory.length >= MIN_SAMPLES;
  const right = captionRight(snap, ui, plotting ? p.shown.length : 0, g);
  const lines = [caption(LEAD + captionLeft(snap, g), right, cols, on)];
  if (plotting) lines.push(...plotRows(snap, p, rows - 1, g, on));
  while (lines.length < rows) lines.push('');
  return lines.map((l) => fit(l, cols));
}
