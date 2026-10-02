// §8.3 frame assembly. Pure: lines in, one escape string out (written with a single stdout.write).
import { MAX_FPS } from '../config';
import { fit, truncate } from '../core/format';
import { CSI, cursorTo } from './ansi';
import { tooSmallMessage, type LayoutPlan, type SectionId, type Size } from './layout';

// Every C0/DEL control except ESC (\x1b), which starts the escape sequences fit() understands.
const CONTROL_RE = /[\x00-\x1a\x1c-\x1f\x7f]/g;

/** Exactly `cols` visible cells (ANSI-aware); control characters dropped; styles closed at the end. */
export function fitLine(s: string, cols: number): string {
  const clean = s.replace(CONTROL_RE, '');
  const out = fit(clean, Math.max(0, cols));
  return clean.includes('\x1b') ? out + CSI.RESET : out;
}

/**
 * `ESC[H` then, per row r, `ESC[r;1H` + `ESC[K` + fitted line. Exactly `rows` rows; never a
 * full clear. EL precedes the line because a line that fills the last column leaves the cursor
 * on that column, and EL after it would erase the cell (xterm/iTerm2/Ghostty semantics).
 */
export function renderFrame(lines: string[], size: Size): string {
  const rows = Math.max(1, Math.floor(size.rows));
  const cols = Math.max(1, Math.floor(size.cols));
  let out: string = CSI.HOME;
  for (let r = 1; r <= rows; r++) {
    out += cursorTo(r) + CSI.CLEAR_LINE + fitLine(lines[r - 1] ?? '', cols);
  }
  return out;
}

export type SectionLines = Partial<Record<SectionId, string[]>>;

/** Full-width rule line from a glyph (`─` or `-` in --ascii). */
export function ruleLine(cols: number, glyph: string): string {
  return glyph.repeat(Math.max(0, cols));
}

/**
 * Place each section's lines at its slot, `rule` at every rule row, blanks elsewhere.
 * Returns exactly plan.rows lines; extra section lines are dropped, missing ones blank.
 * A too-small plan yields only the message line (§8.2).
 */
export function composeLines(plan: LayoutPlan, parts: SectionLines, rule: string): string[] {
  const lines: string[] = new Array<string>(plan.rows).fill('');
  if (plan.tooSmall) {
    if (plan.rows > 0) lines[0] = truncate(tooSmallMessage(plan), plan.cols);
    return lines;
  }
  for (const r of plan.rules) lines[r - 1] = rule;
  for (const slot of plan.slots) {
    const src = parts[slot.id] ?? [];
    for (let i = 0; i < slot.rows; i++) lines[slot.row - 1 + i] = src[i] ?? '';
  }
  return lines;
}

/**
 * §8.3 frame-rate cap (MAX_FPS). `delay(now)` returns 0 when a frame may be written now (and
 * records it), else the ms to wait; the caller writes the latest pending frame after the wait
 * and calls `mark(now)`.
 */
export class FrameGate {
  private last = -Infinity;

  constructor(private readonly minGapMs: number = 1000 / MAX_FPS) {}

  delay(now: number): number {
    const wait = this.last + this.minGapMs - now;
    if (wait <= 0) {
      this.last = now;
      return 0;
    }
    return wait;
  }

  mark(now: number): void {
    this.last = now;
  }
}
