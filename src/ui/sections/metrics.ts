// §8.1 metric cells (LATENCY / LOSS / WI-FI / TRAFFIC + RTT sparkline) and the §8.2 compact variant. Pure.
import { BIN, METRIC_CELL_W, RTT_HISTORY_N } from '../../config';
import { fit, fmtPct, fmtSecs, padEnd, padStart, truncate, visibleWidth } from '../../core/format';
import type { Snapshot, TrendDir } from '../../model/types';
import { GLYPHS, type Glyphs } from '../ansi';
import { LEAD, paint } from './common';
import { sparkline } from './sparkline';
import { compactLine, trafficCell, wifiCell } from './metrics-cells';

/** What metrics() reads from the layout plan (a LayoutPlan satisfies it). */
export interface MetricsPlan { compact: boolean; cols: number }

const LABEL_W = 9; // `internet ` — the value columns start at cell column 10
const COL_A = 17; // first value column ends here (cell-relative)
const COL_B = METRIC_CELL_W - 1; // 23: one cell short of the boundary, so columns never touch (K1)
const COMPACT_CELL_MAX = 37; // §8.2 mockup: LOSS at column 40
const FULL_ROWS = 5; // cell rows before the RTT sparkline row

/** Rounded ms, or the em dash. */
export function msText(v: number | null, g: Glyphs): string {
  return v == null ? g.em : String(Math.round(Math.max(0, v)));
}

export function pctText(v: number | null, g: Glyphs): string {
  return v == null ? g.em : fmtPct(v);
}

/** §7.3 arrow: ▲ worse (yellow), ▼ better (green), '' otherwise. */
export function trendArrow(dir: TrendDir, g: Glyphs, on: boolean): string {
  if (dir === 'worse') return paint('yellow', g.up, on);
  if (dir === 'better') return paint('green', g.down, on);
  return '';
}

/**
 * Label + two right-aligned value columns ending at COL_A / COL_B — at most 23 cells, so a
 * gutter always separates this column from the next one (K1). Values keep every digit: a wide
 * one eats into the padding instead of into its label or its neighbour.
 */
function valueCols(label: string, a: string, b: string): string {
  return padEnd(label, LABEL_W) + padStart(a, COL_A - LABEL_W) + padStart(b, COL_B - COL_A);
}

/** Cell header with the column markers over the same two columns (`LATENCY (60s) p50   p95`). */
function headerCols(head: string, a: string, b: string): string {
  const first = Math.max(visibleWidth(a) + 1, COL_A - visibleWidth(head));
  return head + padStart(a, first) + padStart(b, COL_B - COL_A);
}

function missing(snap: Snapshot, bin: string): boolean {
  return snap.missingBins.includes(bin);
}

function httpText(snap: Snapshot, g: Glyphs): string {
  if (missing(snap, BIN.curl)) return 'curl: missing';
  const h = snap.http;
  if (!h) return g.em;
  if (h.ms != null && h.code != null && h.code > 0) return `${fmtSecs(h.ms)} (${h.code})`;
  return h.kind; // fail / dnsfail without a response
}

/** LATENCY cell: header, router, internet, jitter (+ latency trend arrow), http. */
function latencyCell(snap: Snapshot, g: Glyphs, on: boolean): string[] {
  const head = headerCols('LATENCY (60s)', 'p50', 'p95');
  const http = padEnd('http', LABEL_W) + httpText(snap, g);
  if (missing(snap, BIN.ping)) return [head, 'ping: missing', '', '', http];
  const internet = snap.icmpBlocked // §6.1 rttProxyMs: an HTTP timing, so there is no p95
    ? padEnd('internet', LABEL_W) + padStart(msText(snap.rttProxyMs, g), COL_A - LABEL_W) + ' http'
    : valueCols('internet', msText(snap.inet.p50, g), msText(snap.inet.p95, g));
  const jitField = padStart(msText(snap.jitter, g), COL_A - LABEL_W);
  const jit = snap.jitter == null ? padStart(g.em, COL_A - LABEL_W) : `${jitField} ms`;
  const arrow = trendArrow(snap.trend.latency, g, on);
  return [
    head,
    valueCols('router', msText(snap.gw.p50, g), msText(snap.gw.p95, g)),
    internet,
    padEnd('jitter', LABEL_W) + jit + (arrow ? ' ' + arrow : ''),
    http,
  ];
}

/** LOSS cell: router, internet (+ loss trend arrow), 5m/blips, late/unmeasured. */
function lossCell(snap: Snapshot, g: Glyphs, on: boolean, compact: boolean): string[] {
  const head = headerCols('LOSS' + (snap.lossSource === 'router' ? ' (router)' : ''), '10s', '60s'); // §6.1
  const line = (label: string, l10: number | null, l60: number | null, arrow: string): string =>
    valueCols(label, pctText(l10, g), pctText(l60, g) + arrow);
  const arrow = trendArrow(snap.trend.loss, g, on);
  const internet = snap.icmpBlocked
    ? padEnd('internet', LABEL_W) + `${g.dash} no icmp`
    : line('internet', snap.loss10, snap.loss60, arrow ? (compact ? ' ' : '') + arrow : '');
  const l5 = `5m ${pctText(snap.loss300, g)}`;
  const row4 = compact
    ? padEnd(l5, 8) + padEnd(`blips ${snap.blips}`, 10) + `late ${snap.late60}`
    : padEnd(l5, 8) + `blips ${snap.blips} (60s)`;
  const row5 = compact
    ? padEnd(`unmeasured ${snap.unmeasured60}`, 15) + `errs ${snap.errs}`
    : padEnd(`late ${snap.late60}`, 8) + `unmeasured ${snap.unmeasured60}`;
  if (missing(snap, BIN.ping)) return [head, 'ping: missing', '', row4, row5];
  return [head, line('router', snap.gw.loss10, snap.gw.loss60, ''), internet, row4, row5];
}

/** Row 6 (full): `RTT 60s <60-cell log sparkline>  8–210ms  x = lost`. */
function rttRow(snap: Snapshot, g: Glyphs, on: boolean): string {
  const hist = snap.rttHistory.slice(-RTT_HISTORY_N);
  const nums = hist.filter((v): v is number => v != null);
  const bar = sparkline(hist, RTT_HISTORY_N, { log: true, lostGlyph: paint('red', g.lost, on), ramp: g.ramp });
  const range = nums.length
    ? `${Math.round(Math.min(...nums))}${g.dash}${Math.round(Math.max(...nums))}ms`
    : g.em;
  return `${LEAD}RTT 60s ${bar}  ${range}  ${g.lost} = lost`;
}

/** One w-wide column whose content is capped at w−1 cells, so the next column keeps its gutter. */
function column(s: string | undefined, w: number): string {
  return fit(truncate(s ?? '', w - 1), w);
}

function compactMetrics(snap: Snapshot, plan: MetricsPlan, g: Glyphs, on: boolean, c1: string[]): string[] {
  const cellW = Math.min(COMPACT_CELL_MAX, Math.floor((plan.cols - LEAD.length) / 2));
  const c2 = lossCell(snap, g, on, true);
  const rows: string[] = [];
  for (let i = 0; i < FULL_ROWS; i++) {
    rows.push(truncate(LEAD + column(c1[i], cellW) + (c2[i] ?? ''), plan.cols));
  }
  rows.push(truncate(LEAD + compactLine(snap, g, plan.cols - LEAD.length), plan.cols));
  return rows;
}

/**
 * Six rows. Full: four 24-cell columns at columns 3/27/51/75 plus the RTT sparkline row.
 * Compact: LATENCY + LOSS cells, then the wifi + traffic line (§8.2).
 */
export function metrics(snap: Snapshot, plan: MetricsPlan, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const c1 = latencyCell(snap, g, colorOn);
  if (plan.compact) return compactMetrics(snap, plan, g, colorOn, c1);
  const W = METRIC_CELL_W;
  const c2 = lossCell(snap, g, colorOn, false);
  const c3 = wifiCell(snap, g, colorOn);
  const c4 = trafficCell(snap, g);
  const rows: string[] = [];
  for (let i = 0; i < FULL_ROWS; i++) {
    // the last column has no neighbour, so it may use all W cells (the in/out sparklines do)
    const line = LEAD + column(c1[i], W) + column(c2[i], W) + column(c3[i], W) + fit(c4[i] ?? '', W);
    rows.push(truncate(line, plan.cols));
  }
  rows.push(truncate(rttRow(snap, g, colorOn), plan.cols));
  return rows;
}
