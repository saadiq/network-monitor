// §8.1 TIP row and the key row (live bell / speed / log states, probe rate right-aligned). Pure, ASCII-only.
import { FULL_COLS, SPEED_BYTES } from '../../config';
import { fmtBytes, truncate, visibleWidth } from '../../core/format';
import type { Snapshot, UiState } from '../../model/types';
import { LEAD } from './common';

const MIN_GAP = 2; // between the keys and the right-aligned probe rate
const MIN_MSG_W = 12; // below this a cut message says nothing, so it is dropped instead
const CUT = '...'; // ASCII: this row is written before glyphs are known

/** One row: `  TIP  <tip>` (blank when there is no tip), cut to w. */
export function tip(snap: Snapshot, w: number): string[] {
  return [snap.tip ? truncate(`${LEAD}TIP  ${snap.tip}`, w) : ''];
}

/** §8.4 keys with live states; the size hint is dropped first when the row is too narrow. */
function keyParts(ui: UiState, sizeHint: boolean): string[] {
  const speed = ui.speedRunning ? 'running' : sizeHint ? `${Math.round(SPEED_BYTES / 1000)} KB` : '';
  return [
    'q quit',
    't speed test' + (speed ? ` (${speed})` : ''),
    `b bell:${ui.bellOn ? 'on' : 'off'}`,
    'o open portal',
  ];
}

function footerMsg(snap: Snapshot, ui: UiState): string | null {
  if (!ui.footerMsg) return null;
  if (ui.footerMsgUntil != null && snap.now > ui.footerMsgUntil) return null;
  return ui.footerMsg;
}

function fits(left: string, right: string, w: number): boolean {
  return visibleWidth(left) + (right ? MIN_GAP + visibleWidth(right) : 0) <= w;
}

/** Keys (+ the transient message when one is given), joined by the layout gap. */
function keysRow(ui: UiState, gap: string, hint: boolean, msg: string | null): string {
  return LEAD + [...keyParts(ui, hint), ...(msg ? [msg] : [])].join(gap);
}

/**
 * The message cut to what is left of the row once the keys and `right` have their space, or
 * null when too little is left for it to mean anything.
 */
function cutMsg(bare: string, gap: string, msg: string, right: string, w: number): string | null {
  const room = w - visibleWidth(bare) - gap.length - (right ? MIN_GAP + visibleWidth(right) : 0);
  if (room < MIN_MSG_W) return null;
  return truncate(msg, room - CUT.length) + CUT;
}

/** Left/right halves of the row: the first combination that fits, shedding in §8.4 order. */
function halves(ui: UiState, gap: string, msg: string | null, rights: string[], w: number): [string, string] {
  for (const hint of [true, false]) {
    const left = keysRow(ui, gap, hint, msg);
    for (const right of rights) if (fits(left, right, w)) return [left, right];
  }
  const bare = keysRow(ui, gap, false, null);
  const last = rights[rights.length - 1] ?? '';
  if (msg) {
    const cut = cutMsg(bare, gap, msg, last, w);
    if (cut) return [bare + gap + cut, last];
  }
  for (const right of rights) if (fits(bare, right, w)) return [bare, right];
  return [bare, last];
}

/**
 * One row, exactly w cells: keys (+ transient message) left, `log: … probes ~1.2 MB/h` right.
 * Too narrow for all of it, the row sheds in this order: the probe rate — but only when a
 * transient message needs the room, and never the log status (§10) — then the size hint, then
 * whatever of the message does not fit, which is cut rather than dropped so a key press is
 * never silently ignored.
 */
export function footer(snap: Snapshot, ui: UiState, w: number): string[] {
  const gap = ' '.repeat(w >= FULL_COLS ? 3 : 2);
  const msg = footerMsg(snap, ui);
  const probes = `probes ~${fmtBytes(snap.probeRateEst)}/h`; // §4.10
  const log = ui.logStatus ? `log: ${ui.logStatus}` : null;
  const rights = log ? [`${log}  ${probes}`, log] : msg ? [probes, ''] : [probes];
  const [row, right] = halves(ui, gap, msg, rights, w);
  let left = row;
  const rw = visibleWidth(right);
  if (visibleWidth(left) + MIN_GAP + rw > w) left = truncate(left, Math.max(0, w - rw - MIN_GAP));
  const pad = Math.max(MIN_GAP, w - visibleWidth(left) - rw);
  return [truncate(left + ' '.repeat(pad) + right, w)];
}
