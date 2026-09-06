// §8.1 timeline: bar row + marker row (`▲HH:MM cause` under each drop start; right-most wins). Pure.
import { fmtHm, truncate, visibleWidth } from '../../core/format';
import type { CellState, Outage, Snapshot } from '../../model/types';
import { GLYPHS, cellColor, type ColorName, type Glyphs } from '../ansi';
import { paint } from './common';
import { timelineBar } from './sparkline';

/** What timeline() reads from the layout plan (a LayoutPlan satisfies it). */
export interface TimelinePlan { cols: number; timelineCells: number; cellMs: number }

const NOW_LABEL = 'now';
const NOW_ZONE = NOW_LABEL.length + 1; // ` now` — markers never run into it

/** A fixed-width character row with a color per cell; later puts overwrite earlier ones. */
class MarkerRow {
  private readonly chars: string[];
  private readonly colors: (ColorName | null)[];

  constructor(readonly width: number) {
    this.chars = new Array<string>(width).fill(' ');
    this.colors = new Array<ColorName | null>(width).fill(null);
  }

  put(idx: number, text: string, color: ColorName | null): void {
    let i = idx;
    for (const ch of text) {
      if (i >= this.width) break;
      if (i >= 0) {
        this.chars[i] = ch;
        this.colors[i] = color;
      }
      i++;
    }
  }

  /** One escape pair per run of equal color. */
  render(on: boolean): string {
    let out = '';
    let run = '';
    let cur: ColorName | null = null;
    for (let i = 0; i < this.width; i++) {
      const c = this.colors[i] ?? null;
      if (c !== cur) {
        out += paint(cur, run, on);
        run = '';
        cur = c;
      }
      run += this.chars[i] ?? ' ';
    }
    return out + paint(cur, run, on);
  }
}

/** Drop starts to mark: closed non-sleep outages plus the open one, oldest first (so newest wins). */
function markedOutages(snap: Snapshot): Outage[] {
  const list = snap.outages.filter((o) => !o.sleep);
  if (snap.openOutage) list.push(snap.openOutage);
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Marker text for one drop: the full `▲HH:MM cause`, else the bare stamp, else `▲` — whichever
 * fits before the next marker (or ` now`) without touching it. '' when not even `▲` fits, so a
 * marker is never cut into a fragment nor glued to its neighbour; the bar cell still shows the drop.
 */
function markerText(o: Outage, room: number, arrowRoom: number, g: Glyphs): string {
  const stamp = g.up + fmtHm(o.startedAt);
  const full = `${stamp} ${o.cause ?? o.state.toLowerCase()}`;
  if (visibleWidth(full) <= room) return full;
  if (visibleWidth(stamp) <= room) return stamp;
  return visibleWidth(g.up) <= arrowRoom ? g.up : '';
}

function markerRow(snap: Snapshot, cells: number, cellMs: number, mins: number, g: Glyphs, on: boolean): string {
  const row = new MarkerRow(cells);
  row.put(0, `-${mins}m`, null);
  const windowStart = snap.wall - cells * cellMs; // epoch ms of the oldest cell
  const marks = markedOutages(snap)
    .map((o) => ({ o, idx: Math.floor((o.startedAt - windowStart) / cellMs) }))
    .filter((m) => m.idx >= 0 && m.idx < cells);
  marks.forEach(({ o, idx }, i) => {
    const next = marks[i + 1]?.idx; // the right-most marker owns the rest, up to ` now`
    const room = (next == null ? cells - NOW_ZONE : next - 1) - idx; // a blank cell between markers
    const text = markerText(o, room, (next ?? cells - NOW_ZONE) - idx, g);
    if (text) row.put(idx, text, cellColor(o.state));
  });
  row.put(cells - NOW_LABEL.length, NOW_LABEL, null);
  return row.render(on);
}

/** Two rows: ` LAST 15m ` + colored bar, then the marker row under it. */
export function timeline(snap: Snapshot, plan: TimelinePlan, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const cells = Math.max(0, Math.floor(plan.timelineCells));
  const cellMs = plan.cellMs;
  const mins = Math.round((cells * cellMs) / 60000);
  const label = ` LAST ${mins}m `;
  let states: CellState[] = snap.timeline(cells, cellMs).slice(-cells);
  if (states.length < cells) {
    states = [...new Array<CellState>(cells - states.length).fill('GAP'), ...states];
  }
  const bar = label + timelineBar(states, g, colorOn);
  const markers = ' '.repeat(visibleWidth(label)) + markerRow(snap, cells, cellMs, mins, g, colorOn);
  return [truncate(bar, plan.cols), truncate(markers, plan.cols)];
}
