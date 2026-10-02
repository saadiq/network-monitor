// §8.2 layout planning. Pure: terminal size in, section placement out.
import {
  FULL_COLS, FULL_ROWS, MIN_COLS, MIN_ROWS, SIMPLE_MIN_COLS, SIMPLE_MIN_ROWS, TIMELINE_COMPACT, TIMELINE_FULL,
} from '../config';
import type { View } from '../model/types';

export interface Size { cols: number; rows: number }

/** Sections of the advanced (§8.1/§8.2) screen. */
export type AdvancedId = 'header' | 'banner' | 'activities' | 'path' | 'footer' | 'timeline' | 'metrics' | 'drops' | 'tip';
/** Sections of the simple screen (simple-view spec §3). */
export type SimpleId = 'header' | 'status' | 'chips' | 'chain' | 'chart' | 'timeline' | 'tip' | 'footer';
export type SectionId = AdvancedId | SimpleId;

/** One placed section: 1-based start row and the rows it owns. */
export interface Slot { id: SectionId; row: number; rows: number }

export interface LayoutPlan {
  view: View; // which screen this plan is for
  cols: number;
  rows: number;
  tooSmall: boolean; // below the view's minimum: frame is only tooSmallMessage()
  compact: boolean; // < 100 cols or < 27 rows (§8.2 variants of metrics/path); false in the simple view
  sections: SectionId[]; // placed sections, top → bottom
  slots: Slot[]; // same order, with row positions
  rules: number[]; // 1-based rows holding a rule line
  timelineCells: number; // 90 at ≥ 100 cols, else 60
  cellMs: number; // 10 s / 15 s
  activitiesRows: number; // 1 at ≥ 100 cols, else 2; 0 when not placed
  dropsRows: number; // 4, or 3 at < 27 rows; 0 when not placed
}

/** §8.2 placement priority: a section is placed when its rows still fit. */
const PRIORITY: readonly AdvancedId[] = [
  'header', 'banner', 'activities', 'path', 'footer', 'timeline', 'metrics', 'drops', 'tip',
];
/** Screen order, top → bottom (footer pinned to the last row). */
const DISPLAY: readonly AdvancedId[] = [
  'header', 'banner', 'activities', 'path', 'metrics', 'timeline', 'drops', 'tip', 'footer',
];
/** Rule candidates ("directly below section X"), top → bottom; added last while rows remain. */
const RULES_FULL: readonly AdvancedId[] = ['header', 'banner', 'activities', 'path', 'metrics', 'timeline', 'drops'];
/** Compact keeps banner/activities/path as one block (§8.2 mockup). */
const RULES_COMPACT: readonly AdvancedId[] = ['header', 'path', 'metrics', 'timeline', 'drops'];

function rowsNeeded(cols: number, rows: number): Record<AdvancedId, number> {
  return {
    header: 1,
    banner: 2,
    activities: cols >= FULL_COLS ? 1 : 2,
    path: 1,
    footer: 1,
    timeline: 2,
    metrics: 6,
    drops: rows >= FULL_ROWS ? 4 : 3,
    tip: 1,
  };
}

export function planLayout(size: Size): LayoutPlan {
  const cols = Math.max(0, Math.floor(size.cols));
  const rows = Math.max(0, Math.floor(size.rows));
  const tooSmall = cols < MIN_COLS || rows < MIN_ROWS;
  const compact = cols < FULL_COLS || rows < FULL_ROWS;
  const tl = cols >= FULL_COLS ? TIMELINE_FULL : TIMELINE_COMPACT;
  const plan: LayoutPlan = {
    view: 'advanced', cols, rows, tooSmall, compact, sections: [], slots: [], rules: [],
    timelineCells: tl.cells, cellMs: tl.cellMs, activitiesRows: 0, dropsRows: 0,
  };
  if (tooSmall) return plan;

  const need = rowsNeeded(cols, rows);
  const placed = new Set<AdvancedId>();
  let free = rows;
  for (const id of PRIORITY) {
    if (need[id] <= free) {
      placed.add(id);
      free -= need[id];
    }
  }
  const ruleAfter = new Set<AdvancedId>();
  for (const id of compact ? RULES_COMPACT : RULES_FULL) {
    if (free <= 0) break;
    if (!placed.has(id)) continue;
    ruleAfter.add(id);
    free -= 1;
  }

  let row = 1;
  for (const id of DISPLAY) {
    if (!placed.has(id)) continue;
    if (id === 'footer') {
      plan.slots.push({ id, row: rows, rows: 1 }); // spare rows stay blank above it
      continue;
    }
    plan.slots.push({ id, row, rows: need[id] });
    row += need[id];
    if (ruleAfter.has(id)) plan.rules.push(row++);
  }
  plan.sections = plan.slots.map((s) => s.id);
  plan.activitiesRows = placed.has('activities') ? need.activities : 0;
  plan.dropsRows = placed.has('drops') ? need.drops : 0;
  return plan;
}

export function slotFor(plan: LayoutPlan, id: SectionId): Slot | null {
  return plan.slots.find((s) => s.id === id) ?? null;
}

/** The single-line frame below a view's minimum (§8.2; simple-view spec §3). ASCII; composeLines cuts it to cols. */
export function tooSmallMessage(p: Size & { view?: View }): string {
  const simpleFits = p.cols >= SIMPLE_MIN_COLS && p.rows >= SIMPLE_MIN_ROWS;
  if (p.view === 'simple' || !simpleFits) return `too small (need ${SIMPLE_MIN_COLS}x${SIMPLE_MIN_ROWS})`;
  return `details need ${MIN_COLS}x${MIN_ROWS} (have ${p.cols}x${p.rows}); press v`;
}
