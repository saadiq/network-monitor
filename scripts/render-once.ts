// TUI smoke: render the §8.1 mockup Snapshot at 100×30 and 80×24 (escapes stripped) so the
// frame can be checked by eye against the spec. Usage: bun run scripts/render-once.ts [--ascii] [--color]
import { frameLines } from '../src/app/render';
import { stripAnsi } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { glyphs } from '../src/ui/ansi';
import type { Size } from '../src/ui/layout';
import { makeSnapshot } from '../tests/helpers/snapshot';
import { bannerLines } from '../src/model/banner-text';
import { pickTip } from '../src/model/tips';

const ascii = process.argv.includes('--ascii');
const colorOn = process.argv.includes('--color');
const g = glyphs(ascii);
const snap = makeSnapshot();
snap.banner = bannerLines(snap, g);
snap.tip = pickTip(snap, g);
const ui: UiState = {
  view: 'advanced', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null, lastSpeed: null, speedRunning: false, logStatus: null,
};

for (const size of [{ cols: 100, rows: 30 }, { cols: 80, rows: 24 }] as Size[]) {
  const lines = frameLines(snap, ui, size, g, colorOn);
  const widths = lines.map((l) => [...stripAnsi(l)].length);
  console.log(`=== ${size.cols}x${size.rows}: ${lines.length} rows, max width ${Math.max(...widths)} ===`);
  console.log('+' + '-'.repeat(size.cols) + '+');
  for (const l of lines) {
    const s = colorOn ? l : stripAnsi(l);
    console.log(`|${s}${' '.repeat(Math.max(0, size.cols - [...stripAnsi(l)].length))}|`);
  }
  console.log('+' + '-'.repeat(size.cols) + '+');
}
