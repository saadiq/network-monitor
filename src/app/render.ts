// §8 TUI frame: sections → layout → one escape string. `frameLines` is pure (used by
// scripts/render-once.ts); `drawTui` writes through the Tty (4 fps cap inside Tty.write).
import type { Snapshot, UiState } from '../model/types';
import type { Glyphs } from '../ui/ansi';
import { composeLines, renderFrame, ruleLine } from '../ui/frame';
import { planLayout, type Size } from '../ui/layout';
import { activities } from '../ui/sections/activities';
import { banner } from '../ui/sections/banner';
import { drops } from '../ui/sections/drops';
import { footer, tip } from '../ui/sections/footer';
import { header } from '../ui/sections/header';
import { metrics } from '../ui/sections/metrics';
import { path } from '../ui/sections/path';
import { timeline } from '../ui/sections/timeline';
import type { Tty } from '../ui/tty';

/** Exactly `size.rows` lines, each fitted by frame.ts when rendered. */
export function frameLines(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string[] {
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

export function buildFrame(snap: Snapshot, ui: UiState, size: Size, g: Glyphs, colorOn: boolean): string {
  return renderFrame(frameLines(snap, ui, size, g, colorOn), size);
}

/** One frame for the current terminal size (resize is polled here as well, §8.3). */
export function drawTui(tty: Tty, snap: Snapshot, ui: UiState, g: Glyphs, colorOn: boolean): void {
  tty.pollResize();
  tty.write(buildFrame(snap, ui, tty.size(), g, colorOn));
}
