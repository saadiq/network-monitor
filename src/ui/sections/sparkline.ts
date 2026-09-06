// §8.1 sparklines (RTT log scale with `x` for lost; KB/s linear) and the timeline bar glyphs.
import type { CellState } from '../../model/types';
import { GLYPHS, cellColor, cellGlyph, color, type Glyphs } from '../ansi';

export interface SparkOpts {
  log?: boolean; // log scale (RTT); linear from 0 otherwise (KB/s)
  lostGlyph: string; // rendered for null values
  ramp?: readonly string[]; // 8 levels low → high; default unicode blocks (pass g.ramp for --ascii)
  min?: number; // fixed range overrides (default: linear 0, log = smallest positive value)
  max?: number;
}

function scale(v: number, log: boolean): number {
  return log ? Math.log(v) : v;
}

/** Exactly `width` cells: the last `width` values left-aligned, padded with spaces. */
export function sparkline(values: (number | null)[], width: number, opts: SparkOpts): string {
  if (width <= 0) return '';
  const ramp = opts.ramp ?? GLYPHS.unicode.ramp;
  const log = opts.log === true;
  const shown = values.slice(-width);
  const nums = shown.filter((v): v is number => v != null && Number.isFinite(v) && (!log || v > 0));
  const lo = opts.min ?? (log ? (nums.length ? Math.min(...nums) : 1) : 0);
  const hi = opts.max ?? (nums.length ? Math.max(...nums) : lo);
  const span = scale(hi, log) - scale(lo, log);
  let out = '';
  for (const v of shown) {
    if (v == null) { out += opts.lostGlyph; continue; }
    if (!Number.isFinite(v) || (log && v <= 0)) { out += ramp[0] ?? ' '; continue; }
    const t = span > 0 ? (scale(v, log) - scale(lo, log)) / span : (v >= hi && hi > 0 ? 1 : 0);
    const idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * ramp.length)));
    out += ramp[idx] ?? ' ';
  }
  return out + ' '.repeat(width - shown.length);
}

/** Timeline cells → glyph run (§8.1 colors), one color escape per run of equal color. */
export function timelineBar(cells: CellState[], g: Glyphs, colorOn = true): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const col = cellColor(cells[i] ?? 'GAP');
    let run = '';
    while (i < cells.length && cellColor(cells[i] ?? 'GAP') === col) { run += cellGlyph(cells[i] ?? 'GAP', g); i++; }
    out += col ? color(col, run, colorOn) : run;
  }
  return out;
}
