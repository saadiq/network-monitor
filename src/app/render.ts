// §8 TUI frame: sections → layout → one escape string. `frameLines` is pure (used by
// scripts/render-once.ts) and draws `ui.view` (simple-view spec §2); `drawTui` writes through the Tty.
import type { Snapshot, UiState } from '../model/types';
import type { Glyphs } from '../ui/ansi';
import { composeLines, renderFrame, ruleLine } from '../ui/frame';
import { planLayout, slotFor, type Size } from '../ui/layout';
import { planSimpleLayout } from '../ui/layout-simple';
import { activities } from '../ui/sections/activities';
import { banner } from '../ui/sections/banner';
import { chain } from '../ui/sections/chain';
import { chart } from '../ui/sections/chart';
import { chips } from '../ui/sections/chips';
import { dropSummary } from '../ui/sections/drop-summary';
import { drops } from '../ui/sections/drops';
import { footer, tip } from '../ui/sections/footer';
import { header, simpleHeader } from '../ui/sections/header';
import { metrics } from '../ui/sections/metrics';
import { path } from '../ui/sections/path';
import { status } from '../ui/sections/status';
import { timeline } from '../ui/sections/timeline';
import type { Tty } from '../ui/tty';

/** The dense §8.1/§8.2 screen. */
function advancedLines(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string[] {
  const plan = planLayout(size);
  const w = size.cols;
  const parts = {
    header: header(snap, w, g, colorOn),
    banner: banner(snap, ui, w, g, colorOn),
    activities: activities(snap, plan, g, colorOn),
    path: path(snap, plan, g, colorOn),
    metrics: metrics(snap, plan, g, colorOn),
    timeline: timeline(snap, plan, g, colorOn),
    drops: drops(snap, plan, g, colorOn),
    tip: tip(snap, w),
    footer: footer(snap, ui, w),
  };
  return composeLines(plan, parts, ruleLine(w, g.rule));
}

/** The default glance screen (simple-view spec §3–§4); spacer rows are blank. */
function simpleLines(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string[] {
  const plan = planSimpleLayout(size);
  const w = size.cols;
  const parts = {
    header: simpleHeader(snap, w, g, colorOn),
    status: status(snap, ui, w, g, colorOn),
    chips: chips(snap, w, g, colorOn),
    chain: chain(snap, w, g, colorOn),
    chart: chart(snap, ui, w, slotFor(plan, 'chart')?.rows ?? 0, g, colorOn),
    timeline: [...timeline(snap, plan, g, colorOn), ...dropSummary(snap, w, g, colorOn)],
    tip: tip(snap, w),
    footer: footer(snap, ui, w),
  };
  return composeLines(plan, parts, '');
}

/** Exactly `size.rows` lines, each fitted by frame.ts when rendered. */
export function frameLines(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string[] {
  return ui.view === 'simple' ? simpleLines(snap, ui, size, g, colorOn) : advancedLines(snap, ui, size, g, colorOn);
}

export function buildFrame(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string {
  return renderFrame(frameLines(snap, ui, size, g, colorOn), size);
}

/** One frame for the current terminal size (resize is polled here as well, §8.3). */
export function drawTui(tty: Tty, snap: Snapshot, ui: UiState, g: Glyphs, colorOn: boolean): void {
  tty.pollResize();
  tty.write(buildFrame(snap, ui, tty.size(), g, colorOn));
}
