// TUI smoke: render the §8.1 mockup Snapshot in the simple and/or advanced view (escapes stripped)
// so frames can be checked by eye against the specs.
// Usage: bun run scripts/render-once.ts [--ascii] [--color] [--view simple|advanced|both]
import { frameLines } from '../src/app/render';
import { stripAnsi } from '../src/core/format';
import type { UiState, View } from '../src/model/types';
import { glyphs } from '../src/ui/ansi';
import type { Size } from '../src/ui/layout';
import { makeSnapshot } from '../tests/helpers/snapshot';
import { bannerLines } from '../src/model/banner-text';
import { pickTip } from '../src/model/tips';

const ascii = process.argv.includes('--ascii');
const colorOn = process.argv.includes('--color');
const vi = process.argv.indexOf('--view');
const which = vi >= 0 ? process.argv[vi + 1] ?? 'both' : 'both';
const views: View[] = which === 'simple' ? ['simple'] : which === 'advanced' ? ['advanced'] : ['simple', 'advanced'];
const SIZES: Record<View, Size[]> = {
  simple: [{ cols: 40, rows: 10 }, { cols: 60, rows: 15 }, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 160, rows: 50 }],
  advanced: [{ cols: 100, rows: 30 }, { cols: 80, rows: 24 }],
};
const g = glyphs(ascii);
const snap = makeSnapshot();
snap.banner = bannerLines(snap, g);
snap.tip = pickTip(snap, g);

for (const view of views) {
  const ui: UiState = {
    view, bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null, lastSpeed: null, speedRunning: false, logStatus: null,
  };
  for (const size of SIZES[view]) {
    const lines = frameLines(snap, ui, size, g, colorOn);
    const widths = lines.map((l) => [...stripAnsi(l)].length);
    console.log(`=== ${view} ${size.cols}x${size.rows}: ${lines.length} rows, max width ${Math.max(...widths)} ===`);
    console.log('+' + '-'.repeat(size.cols) + '+');
    for (const l of lines) {
      const s = colorOn ? l : stripAnsi(l);
      console.log(`|${s}${' '.repeat(Math.max(0, size.cols - [...stripAnsi(l)].length))}|`);
    }
    console.log('+' + '-'.repeat(size.cols) + '+');
  }
}
