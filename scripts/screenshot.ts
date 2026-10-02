// README screenshot: the simple view of an illustrative mock Snapshot (deterministic, no real network
// details) → docs/screenshot.svg, and docs/screenshot.png when rsvg-convert is installed
// (`brew install librsvg`). Usage: bun run scripts/screenshot.ts
import { frameLines } from '../src/app/render';
import { bannerLines } from '../src/model/banner-text';
import { pickTip } from '../src/model/tips';
import type { CellState } from '../src/model/types';
import { glyphs } from '../src/ui/ansi';
import { makeSnapshot, makeUi } from '../tests/helpers/snapshot';
import { ansiToSvg } from './ansi-svg';

const SIZE = { cols: 100, rows: 30 };
const SVG_PATH = 'docs/screenshot.svg';
const PNG_PATH = 'docs/screenshot.png';

/** 60 s of internet RTTs: a 45–70 ms baseline, a 210 ms and a 340 ms spike, one lost reply. */
const RTT: (number | null)[] = [
  48, 52, 47, 55, 61, 58, 49, 46, 53, 57, 62, 70, 66, 58, 51, 49, 55, 60, 210, 95,
  64, 57, 52, 49, null, 48, 53, 59, 63, 58, 54, 50, 47, 52, 56, 61, 67, 72, 68, 60,
  55, 51, 49, 46, 52, 340, 120, 66, 58, 53, 50, 48, 52, 57, 63, 59, 54, 51, 49, 53,
];

const g = glyphs(false);
const snap = makeSnapshot({ rttHistory: RTT });
// the timeline shows the mock's three drops (wi-fi, portal, uplink) instead of a solid green bar
snap.timeline = (cells: number, cellMs: number): CellState[] => Array.from({ length: cells }, (_, i) => {
  const start = snap.wall - (cells - i) * cellMs;
  const o = snap.outages.find((x) => x.startedAt < start + cellMs && (x.endedAt ?? snap.wall) > start);
  return o ? o.state : 'UP';
});
snap.banner = bannerLines(snap, g);
snap.tip = pickTip(snap, g);

const lines = frameLines(snap, makeUi(), SIZE, g, true);
await Bun.write(SVG_PATH, ansiToSvg(lines, { ...SIZE, title: 'netmon' }));
console.log(`wrote ${SVG_PATH}`);

const rsvg = Bun.which('rsvg-convert');
if (!rsvg) {
  console.log('rsvg-convert not found (brew install librsvg): skipped the PNG');
} else {
  const r = Bun.spawnSync([rsvg, '--zoom', '2', '--output', PNG_PATH, SVG_PATH]);
  if (r.exitCode !== 0) throw new Error(`rsvg-convert failed: ${r.stderr.toString()}`);
  console.log(`wrote ${PNG_PATH}`);
}
