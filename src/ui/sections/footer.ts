// §8.1 TIP row and the key row (live bell / speed / log states, probe rate right-aligned). Pure, ASCII-only.
// The keys depend on the view (simple-view spec §4).
import { FULL_COLS, SPEED_BYTES } from '../../config';
import { fmtBytes, truncate, visibleWidth } from '../../core/format';
import type { Snapshot, UiState, View } from '../../model/types';
import { LEAD } from './common';

const MIN_GAP = 2; // between the keys and the right-aligned probe rate
const MIN_MSG_W = 12; // below this a cut message says nothing, so it is dropped instead
const CUT = '...'; // ASCII: this row is written before glyphs are known

/** One row: `  TIP  <tip>` (blank when there is no tip), cut to w. */
export function tip(snap: Snapshot, w: number): string[] {
  return [snap.tip ? truncate(`${LEAD}TIP  ${snap.tip}`, w) : ''];
}

/** How hard the key labels are squeezed, in §8.4 shedding order. */
type KeyLevel = 'hint' | 'plain' | 'short';
const LEVELS: readonly KeyLevel[] = ['hint', 'plain', 'short'];

function speedKey(ui: UiState, level: KeyLevel, view: View): string {
  const label = level === 'short' ? 't speed' : 't speed test';
  if (ui.speedRunning) return `${label} (running)`;
  return level === 'hint' && view === 'advanced' ? `${label} (${Math.round(SPEED_BYTES / 1000)} KB)` : label;
}

/** §8.4 keys with live states for the current view (simple-view spec §4). */
function keyParts(snap: Snapshot, ui: UiState, level: KeyLevel): string[] {
  const bell = `b bell:${ui.bellOn ? 'on' : 'off'}`;
  const t = speedKey(ui, level, ui.view);
  if (ui.view === 'simple') return [...(snap.state === 'PORTAL' ? ['o login'] : []), 'v details', t, bell, 'q quit'];
  return ['q quit', t, bell, level === 'short' ? 'o portal' : 'o open portal', 'v simple'];
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
function keysRow(snap: Snapshot, ui: UiState, gap: string, level: KeyLevel, msg: string | null): string {
  return LEAD + [...keyParts(snap, ui, level), ...(msg ? [msg] : [])].join(gap);
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

/**
 * Left/right halves of the row: the first combination that fits. With a message the right side
 * is shed before labels are squeezed; without one, labels are squeezed first (§8.4, §10).
 */
function halves(snap: Snapshot, ui: UiState, gap: string, msg: string | null, rights: string[], w: number): [string, string] {
  const tries: [KeyLevel, string][] = msg
    ? LEVELS.flatMap((l) => rights.map((r): [KeyLevel, string] => [l, r]))
    : rights.flatMap((r) => LEVELS.map((l): [KeyLevel, string] => [l, r]));
  for (const [level, right] of tries) {
    const left = keysRow(snap, ui, gap, level, msg);
    if (fits(left, right, w)) return [left, right];
  }
  const bare = keysRow(snap, ui, gap, 'short', null);
  const last = rights[rights.length - 1] ?? '';
  if (msg) {
    const cut = cutMsg(bare, gap, msg, last, w);
    if (cut) return [bare + gap + cut, last];
    // no room beside the keys (narrow simple view): the message alone, until it expires
    const room = w - LEAD.length - (last ? MIN_GAP + visibleWidth(last) : 0);
    return [LEAD + truncate(msg, Math.max(0, room)), last];
  }
  for (const right of rights) if (fits(bare, right, w)) return [bare, right];
  return [bare, last];
}

/**
 * One row, exactly w cells: keys (+ transient message) left, `log: … probes ~1.2 MB/h` right (the
 * simple view has no probe rate). Key labels squeeze through three levels — size hint
 * (`t speed test (250 KB)`, advanced only), plain (`t speed test`), short (`t speed`, `o portal`).
 * With a transient message the probe rate is shed before the labels are squeezed; without one,
 * labels are squeezed first. The log status is never shed (§10). A message that does not fit
 * beside the shortest keys is cut; with fewer than 12 cells left for it, it is shown alone (keys
 * hidden until it expires) so a key press is never silently ignored.
 */
export function footer(snap: Snapshot, ui: UiState, w: number): string[] {
  const gap = ' '.repeat(w >= FULL_COLS ? 3 : 2);
  const msg = footerMsg(snap, ui);
  const probes = ui.view === 'simple' ? null : `probes ~${fmtBytes(snap.probeRateEst)}/h`; // §4.10
  const log = ui.logStatus ? `log: ${ui.logStatus}` : null;
  let rights: string[];
  if (log) rights = probes ? [`${log}  ${probes}`, log] : [log];
  else if (probes) rights = msg ? [probes, ''] : [probes];
  else rights = [''];
  const [row, right] = halves(snap, ui, gap, msg, rights, w);
  let left = row;
  const rw = visibleWidth(right);
  const minGap = rw > 0 ? MIN_GAP : 0; // nothing on the right (simple view): no gap to keep
  if (visibleWidth(left) + minGap + rw > w) left = truncate(left, Math.max(0, w - rw - minGap));
  const pad = Math.max(minGap, w - visibleWidth(left) - rw);
  return [truncate(left + ' '.repeat(pad) + right, w)];
}
