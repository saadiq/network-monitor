// Simple-view layout (simple-view spec §3). Pure: terminal size in, section placement out.
import {
  CHART_MAX_ROWS, CHART_MIN_ROWS, FULL_COLS, SIMPLE_MIN_COLS, SIMPLE_MIN_ROWS, TIMELINE_FULL,
  TIMELINE_LABEL_W, WIN_HISTORY_MS,
} from '../config';
import type { LayoutPlan, Size } from './layout';

type SimpleId = 'header' | 'status' | 'chips' | 'chain' | 'chart' | 'timeline' | 'tip' | 'footer';

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
    view: 'simple', cols, rows, tooSmall, compact: cols < FULL_COLS, sections: [], slots: [], rules: [],
    timelineCells: tl.cells, cellMs: tl.cellMs, activitiesRows: 0, dropsRows: 0, chartRows: 0,
  };
  if (tooSmall) return plan;

  const need: Record<SimpleId, number> = { ...NEED };
  const placed = new Set<SimpleId>();
  let free = rows;
  for (const id of PRIORITY) {
    if (need[id] <= free) {
      placed.add(id);
      free -= need[id];
    }
  }
  const spacerAfter = new Set<SimpleId>();
  for (const id of SPACER_AFTER) {
    if (free <= 0) break;
    if (!placed.has(id)) continue;
    spacerAfter.add(id);
    free -= 1;
  }
  if (placed.has('chart')) {
    const grow = Math.min(free, CHART_MAX_ROWS - CHART_MIN_ROWS);
    need.chart += grow;
    free -= grow;
  }

  let row = 1;
  for (const id of DISPLAY) {
    if (!placed.has(id)) continue;
    if (id === 'footer') {
      plan.slots.push({ id, row: rows, rows: 1 });
      continue;
    }
    plan.slots.push({ id, row, rows: need[id] });
    row += need[id];
    if (spacerAfter.has(id)) plan.rules.push(row++);
  }
  plan.sections = plan.slots.map((s) => s.id);
  plan.chartRows = placed.has('chart') ? need.chart : 0;
  return plan;
}
