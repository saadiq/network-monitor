// Shared helpers for the UI sections (§8.1 glyph/color rules). Pure.
import type { Grade, State, VerdictLevel } from '../../model/types';
import { color, type ColorName, type Glyphs } from '../ansi';

/** What the sections read from the layout plan (structurally a LayoutPlan plus `cols`). */
export interface SectionPlan {
  compact: boolean;
  cols: number;
}

/** Two-space indent used by every body row in the mockups. */
export const LEAD = '  ';

export function stateWord(s: State): string {
  return s === 'NO_LINK' ? 'NO LINK' : s;
}

export function stateColor(s: State): ColorName {
  switch (s) {
    case 'UP': return 'green';
    case 'DEGRADED': return 'yellow';
    case 'PORTAL': return 'magenta';
    case 'WARMUP': return 'dim';
    default: return 'red'; // DOWN / NO_LINK
  }
}

/** §7.2 colors: A/B green, C yellow, D red. */
export function gradeColor(g: Grade): ColorName | null {
  if (g === 'A' || g === 'B') return 'green';
  if (g === 'C') return 'yellow';
  if (g === 'D') return 'red';
  return null;
}

export type Mark = 'ok' | 'shaky' | 'fail' | 'dash' | 'unknown';

/** §8.1: ✔ green, ~ yellow, ✘ red, – dim (no icmp), ? dim (unknown). */
export function markGlyph(m: Mark, g: Glyphs): string {
  switch (m) {
    case 'ok': return g.ok;
    case 'shaky': return g.shaky;
    case 'fail': return g.fail;
    case 'dash': return g.dash;
    default: return g.unknown;
  }
}

export function markColor(m: Mark): ColorName {
  switch (m) {
    case 'ok': return 'green';
    case 'shaky': return 'yellow';
    case 'fail': return 'red';
    default: return 'dim';
  }
}

export function levelMark(level: VerdictLevel): Mark {
  switch (level) {
    case 'OK': return 'ok';
    case 'SHAKY': return 'shaky';
    case 'NO': return 'fail';
    default: return 'unknown';
  }
}

/** color() that accepts a null color (= plain). */
export function paint(c: ColorName | null, s: string, on: boolean): string {
  return c ? color(c, s, on) : s;
}
