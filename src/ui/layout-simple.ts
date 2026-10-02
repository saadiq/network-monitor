// Simple-view layout (simple-view spec §3). Pure: terminal size in, section placement out.
import {
  CHART_MAX_ROWS, CHART_MIN_ROWS, SIMPLE_MIN_COLS, SIMPLE_MIN_ROWS, TIMELINE_FULL,
  TIMELINE_LABEL_W, WIN_HISTORY_MS,
} from '../config';
import type { LayoutPlan, SimpleId, Size } from './layout';

const NEED: Readonly<Record<SimpleId, number>> = {
  header: 1, status: 2, chips: 2, chain: 1, chart: CHART_MIN_ROWS, timeline: 3, tip: 1, footer: 1,
};
/** Placement priority: a section is placed when its rows still fit. */
const PRIORITY: readonly SimpleId[] = ['header', 'status', 'chips', 'footer', 'timeline', 'chain', 'chart', 'tip'];
/** Screen order, top → bottom (footer pinned to the last row). */
const DISPLAY: readonly SimpleId[] = ['header', 'status', 'chips', 'chain', 'chart', 'timeline', 'tip', 'footer'];
/** A blank spacer row goes below each of these (when placed), top to bottom, while rows remain. */
const SPACER_AFTER: readonly SimpleId[] = ['header', 'status', 'chips', 'chain', 'chart', 'timeline'];

/** Timeline cells for a row width: the bar fills the row (at most 90 cells) and spans 15 minutes. */
export function simpleTimeline(cols: number): { cells: number; cellMs: number } {
  const cells = Math.max(1, Math.min(TIMELINE_FULL.cells, cols - TIMELINE_LABEL_W));
  return { cells, cellMs: Math.round(WIN_HISTORY_MS / cells) };
}

export function planSimpleLayout(size: Size): LayoutPlan {
  const cols = Math.max(0, Math.floor(size.cols));
  const rows = Math.max(0, Math.floor(size.rows));
  const tooSmall = cols < SIMPLE_MIN_COLS || rows < SIMPLE_MIN_ROWS;
  const tl = simpleTimeline(cols);
  const plan: LayoutPlan = {
    view: 'simple', cols, rows, tooSmall, compact: false, sections: [], slots: [], rules: [],
    timelineCells: tl.cells, cellMs: tl.cellMs, activitiesRows: 0, dropsRows: 0,
  };
  if (tooSmall) return plan;

  const placed = new Set<SimpleId>();
  let free = rows;
  for (const id of PRIORITY) {
    if (NEED[id] <= free) {
      placed.add(id);
      free -= NEED[id];
    }
  }
  const spacerAfter = new Set<SimpleId>();
  for (const id of SPACER_AFTER) {
    if (free <= 0) break;
    if (!placed.has(id)) continue;
    spacerAfter.add(id);
    free -= 1;
  }
  const chartRows = CHART_MIN_ROWS + Math.min(free, CHART_MAX_ROWS - CHART_MIN_ROWS); // leftover rows

  let row = 1;
  for (const id of DISPLAY) {
    if (!placed.has(id)) continue;
    if (id === 'footer') {
      plan.slots.push({ id, row: rows, rows: 1 });
      continue;
    }
    const n = id === 'chart' ? chartRows : NEED[id];
    plan.slots.push({ id, row, rows: n });
    row += n;
    if (spacerAfter.has(id)) plan.rules.push(row++);
  }
  plan.sections = plan.slots.map((s) => s.id);
  return plan;
}
