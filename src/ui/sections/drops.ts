// §8.1 / §8.2 DROPS table (newest first) with the stats column beside it. Pure.
import { fmtDuration, fmtTime, padEnd, truncate, visibleWidth } from '../../core/format';
import type { Outage, Snapshot } from '../../model/types';
import { GLYPHS, cellColor, type Glyphs } from '../ansi';
import { LEAD, paint } from './common';

/** What drops() reads from the layout plan (a LayoutPlan satisfies it). */
export interface DropsPlan { compact: boolean; cols: number; dropsRows: number }

type Mode = 'full' | 'compact' | 'narrow';

const PREFIX_W = 9; // `  DROPS  `
const CAUSE_COL = 30; // 0-based column of the cause text
const STATS_COL: Readonly<Record<Mode, number>> = { full: 53, compact: 44, narrow: 39 };
const NARROW_BELOW_COLS = 80;

const FULL_CAUSE: Readonly<Record<string, string>> = {
  uplink: 'uplink (router fine)', portal: 'portal login needed', wifi: 'wi-fi link lost',
  router: 'router unreachable', 'not-joined': 'not joined to wi-fi', 'no-dhcp': 'no address (DHCP)',
  unknown: 'no route',
};
const SHORT_CAUSE: Readonly<Record<string, string>> = {
  uplink: 'uplink', portal: 'portal', wifi: 'wi-fi link', router: 'router',
  'not-joined': 'no wi-fi', 'no-dhcp': 'no dhcp', unknown: 'no route',
};

function causeText(o: Outage, mode: Mode): string {
  const key = o.cause ?? '';
  const fallback = o.state.toLowerCase().replace('_', ' ');
  if (mode === 'full') return FULL_CAUSE[key] ?? fallback;
  if (mode === 'narrow' && key === 'wifi') return 'wi-fi';
  return SHORT_CAUSE[key] ?? fallback;
}

/** `~22s` · `~4m` · `~1h02m` — rounded for prose. */
function fmtApprox(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return fmtDuration(s);
}

/** Cut at the last ` · ` / `; ` boundary that fits in w; hard-truncate when none does. */
export function fitWords(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let best = -1;
  for (const m of s.matchAll(/ [·|] |; /g)) {
    if (m.index != null && visibleWidth(s.slice(0, m.index)) <= w) best = m.index;
    else break;
  }
  return best > 0 ? s.slice(0, best) : truncate(s, w);
}

/** Right-hand column lines (§8.1 mockup); one line when there are no drops yet. */
function statsLines(snap: Snapshot, g: Glyphs, compact: boolean): string[] {
  const d = snap.drops;
  const n = d.dropsSession;
  const sep = ` ${g.sep} `;
  const dur = (s: number | null): string => (s == null ? g.em : fmtDuration(s));
  const pc = (v: number | null): string => (v == null ? g.em : `${Math.round(v)}%`);
  const up15 = compact ? `uptime ${pc(d.uptime15)}` : `uptime 15m ${pc(d.uptime15)}`;
  if (n === 0) return [['no drops yet', up15, ...(compact ? [] : [`1h ${pc(d.uptime60)}`])].join(sep)];
  const k = d.drops15;
  const l1 = [`${k} drop${k === 1 ? '' : 's'}/15m`, `median ${dur(d.dropMedianS)}`, `${compact ? 'max' : 'longest'} ${dur(d.dropLongestS)}`];
  const l2 = [...(d.sinceLastDrop == null ? [] : [`last ended ${fmtDuration(d.sinceLastDrop)} ago`]), up15];
  const l3 = `usually ~${dur(d.dropMedianS)}; ${d.dropUnder30} of ${n} under 30s`;
  const l4 = d.dropGapS == null ? '' : `gap between drops ~${fmtApprox(d.dropGapS)}`;
  return [l1.join(sep), l2.join(sep), l3, l4];
}

function tableRow(prefix: string, o: Outage, lasted: string, cause: string): string {
  return padEnd(prefix, PREFIX_W) + padEnd(String(o.n), 3) + padEnd(fmtTime(o.startedAt), 10) + padEnd(lasted, 8) + cause;
}

/** Left-hand table lines: header row (full only) + outage rows; a placeholder when there are none. */
function tableLines(snap: Snapshot, mode: Mode, rows: number, g: Glyphs, on: boolean): string[] {
  const causeW = STATS_COL[mode] - CAUSE_COL - 1;
  const label = LEAD + 'DROPS';
  const table: string[] = [];
  if (mode === 'full') {
    table.push(padEnd(label, PREFIX_W) + padEnd('#', 3) + padEnd('started', 10) + padEnd('lasted', 8) + 'cause');
  }
  const list: Outage[] = snap.openOutage ? [snap.openOutage] : [];
  list.push(...snap.outages.filter((o) => !o.sleep)); // sleep-closed outages are not drops (§6.3)
  const shown = list.slice(0, rows - table.length);
  shown.forEach((o, i) => {
    const prefix = mode !== 'full' && i === 0 ? label : '';
    const open = o.endedAt == null;
    const lasted = open
      ? paint(cellColor(o.state), fmtDuration(snap.downFor ?? o.durationS) + g.ellipsis, on)
      : fmtDuration(o.durationS);
    table.push(tableRow(prefix, o, lasted, truncate(causeText(o, mode), causeW)));
  });
  if (shown.length === 0) {
    table.push(padEnd(mode === 'full' ? '' : label, PREFIX_W) + padEnd(g.em, 3) + 'no drops this session');
  }
  return table;
}

/** dropsRows lines (4 full / 3 compact): table on the left, stats column on the right. */
export function drops(snap: Snapshot, plan: DropsPlan, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const rows = Math.max(0, Math.floor(plan.dropsRows));
  if (rows === 0) return [];
  const mode: Mode = !plan.compact ? 'full' : plan.cols < NARROW_BELOW_COLS ? 'narrow' : 'compact';
  const statsCol = STATS_COL[mode];
  const table = tableLines(snap, mode, rows, g, colorOn);
  const stats = statsLines(snap, g, mode !== 'full');
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = padEnd(table[i] ?? '', statsCol) + fitWords(stats[i] ?? '', plan.cols - statsCol);
    out.push(truncate(line, plan.cols));
  }
  return out;
}
