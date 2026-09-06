// CSI constants, colors and glyph tables (§8.1, §8.3). Pure string helpers.
import { stripAnsi } from '../core/format';
import type { CellState } from '../model/types';

export const CSI = {
  ALT_ON: '\x1b[?1049h',
  ALT_OFF: '\x1b[?1049l',
  CURSOR_HIDE: '\x1b[?25l',
  CURSOR_SHOW: '\x1b[?25h',
  HOME: '\x1b[H',
  CLEAR_LINE: '\x1b[K',
  CLEAR_SCREEN: '\x1b[2J',
  INVERSE: '\x1b[7m',
  INVERSE_OFF: '\x1b[27m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  INTENSITY_OFF: '\x1b[22m',
  FG_DEFAULT: '\x1b[39m',
  RESET: '\x1b[0m',
  BELL: '\x07',
} as const;

/** `ESC [ row ; col H` (1-based). */
export function cursorTo(row: number, col = 1): string {
  return `\x1b[${row};${col}H`;
}

export type ColorName = 'green' | 'yellow' | 'red' | 'magenta' | 'dim' | 'bold' | 'inverse';

// Specific "off" codes (not RESET) so styles nest, e.g. green text inside an inverse banner.
const SGR: Readonly<Record<ColorName, readonly [string, string]>> = {
  green: ['\x1b[32m', CSI.FG_DEFAULT],
  yellow: ['\x1b[33m', CSI.FG_DEFAULT],
  red: ['\x1b[31m', CSI.FG_DEFAULT],
  magenta: ['\x1b[35m', CSI.FG_DEFAULT],
  dim: [CSI.DIM, CSI.INTENSITY_OFF],
  bold: [CSI.BOLD, CSI.INTENSITY_OFF],
  inverse: [CSI.INVERSE, CSI.INVERSE_OFF],
};

/** Wrap s in a color/style when enabled; unchanged (and no escapes) otherwise. */
export function color(name: ColorName, s: string, enabled: boolean): string {
  if (!enabled || s === '') return s;
  const [on, off] = SGR[name];
  return on + s + off;
}

/** Remove all escape sequences. */
export function strip(s: string): string {
  return stripAnsi(s);
}

export interface Glyphs {
  ok: string; // ✔ hop/verdict ok
  shaky: string; // ~
  fail: string; // ✘
  dash: string; // – (no icmp)
  unknown: string; // ?
  up: string; // ▲ trend worse / drop marker
  down: string; // ▼ trend better
  cellUp: string; // █ timeline UP
  cellDegraded: string; // ▓
  cellPortal: string; // ▒
  cellDown: string; // ░ DOWN / NO_LINK
  cellGap: string; // · WARMUP / sleep gap
  ramp: readonly string[]; // sparkline levels low → high
  lost: string; // x in the RTT sparkline
  bullet: string; // ● before the state word
  arrow: string; // → between hops
  rule: string; // ─ horizontal rule
  sep: string; // · header separator
  dl: string; // ↓ download
  ul: string; // ↑ upload
  em: string; // — em dash / unknown value
  ellipsis: string; // …
}

export const GLYPHS: Readonly<Record<'unicode' | 'ascii', Glyphs>> = {
  unicode: {
    ok: '✔', shaky: '~', fail: '✘', dash: '–', unknown: '?', up: '▲', down: '▼',
    cellUp: '█', cellDegraded: '▓', cellPortal: '▒', cellDown: '░', cellGap: '·',
    ramp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'], lost: 'x',
    bullet: '●', arrow: '→', rule: '─', sep: '·', dl: '↓', ul: '↑', em: '—', ellipsis: '…',
  },
  ascii: {
    ok: 'OK', shaky: '~', fail: 'X', dash: '-', unknown: '?', up: '^', down: 'v',
    cellUp: '#', cellDegraded: '=', cellPortal: ':', cellDown: '.', cellGap: '.',
    ramp: ['_', '.', '-', '=', '+', '*', '#', '@'], lost: 'x',
    bullet: '*', arrow: '->', rule: '-', sep: '|', dl: 'v', ul: '^', em: '-', ellipsis: '...',
  },
};

export function glyphs(ascii: boolean): Glyphs {
  return ascii ? GLYPHS.ascii : GLYPHS.unicode;
}

/** Timeline cell glyph (§8.1). */
export function cellGlyph(cell: CellState, g: Glyphs): string {
  switch (cell) {
    case 'UP': return g.cellUp;
    case 'DEGRADED': return g.cellDegraded;
    case 'PORTAL': return g.cellPortal;
    case 'DOWN':
    case 'NO_LINK': return g.cellDown;
    default: return g.cellGap;
  }
}

/** Timeline cell color (§8.1); null = uncolored (gap/warmup). */
export function cellColor(cell: CellState): ColorName | null {
  switch (cell) {
    case 'UP': return 'green';
    case 'DEGRADED': return 'yellow';
    case 'PORTAL': return 'magenta';
    case 'DOWN':
    case 'NO_LINK': return 'red';
    default: return null;
  }
}
