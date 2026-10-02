# Simple View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual, color-driven simple view as netmon's default TUI screen, keep today's dense screen as an advanced view, and toggle between them with `v` (or start in advanced with `--advanced`).

**Architecture:** A second pure layout planner (`planSimpleLayout`) places new pure sections (status badge, activity chips, hop chain, latency chart, drop summary) plus the reused timeline/tip/footer. `frameLines` branches on `UiState.view`. The hop model is extracted from `path.ts` so the PATH row and the chain share it. No new probes or Snapshot fields.

**Tech Stack:** Bun 1.4 + TypeScript (strict, `noUncheckedIndexedAccess`), `bun:test`, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-simple-view-design.md` (extends the main spec `docs/superpowers/specs/2026-09-06-network-monitor-design.md`).

## Global Constraints

- Zero runtime dependencies; never add one. `@types/bun` stays dev-only.
- ≤ 300 lines per file, ≤ 100 lines per function (tests included — `tests/sections-b.test.ts` is at 299 lines: edit it in place only).
- UI sections are pure: plain data in, strings out. Side effects stay in `proc`, `clock`, pollers, `tty`, `alerts`, `open-portal`, `jsonl` I/O and `main`.
- Colors: only the existing SGR set through `color()`/`paint()` (green, yellow, red, magenta, dim, bold, inverse). With color off, no escape is emitted.
- `--ascii` output is pure ASCII; `--no-color` output carries status by glyph, never by color alone.
- Every rendered row is exactly `cols` visible cells (`fit`); never wider.
- Simple view minimum 40×10; advanced view minimum stays 72×18.
- Plain mode (§8.5), the JSONL log (§11), the quit report (§8.6) and alerts (§8.7) are unchanged.
- Never press `o` in a live TUI; never change network settings.
- Verification per task: `bun test` (all green) and `bunx tsc --noEmit` (clean).
- Granular commits, one logical change each; every commit message ends with the line
  `Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub` (use a second `-m`).

## Review Focus

1. A side pane narrower than 72×18 while the user is in the advanced view (they pressed `v`): the frame must tell them `v` returns to the simple view, not just "too small". → Task 3 test.
2. `--no-color` / `NO_COLOR`: the badge and hop chain must still show status (`● UP`, `✔ ~ ✘` marks instead of colored dots). → Tasks 4 and 6 tests.
3. Extreme RTTs (satellite 12000 ms, every sample lost, a single sample): the chart's axis label and bars must stay inside the row and say something sensible. → Task 7 tests.
4. A transient footer message in the simple view at 40 cols (e.g. a speed-test result): it must be shown — cut beside the keys when there is room, alone when there is not — never silently dropped. → Task 9 test.
5. Ethernet / no pingable gateway: the chain shows only the hops that exist and the header shows the bare interface. → Tasks 4 and 6 tests.

---

### Task 1: View state, `--advanced` flag and the `v` key

**Files:**
- Modify: `src/model/types.ts` (add `View`, `UiState.view`)
- Modify: `src/cli/types.ts`, `src/cli/args.ts` (flag + usage)
- Modify: `src/ui/keys.ts` (`KEY_VIEW`, `KeyActions.view`)
- Modify: `src/app/actions.ts` (`viewAction`)
- Modify: `src/main.ts` (seed `ui.view`, bind `v`)
- Modify (fixtures only): `tests/sections-b.test.ts:19-20`, `tests/sections-b2.test.ts:19-20`, `tests/sections-a.fixture.ts:85-90`, `scripts/render-once.ts:19-21`, `tests/args.test.ts:8-13`, `tests/app-probes.test.ts:15-18`
- Test: `tests/view-keys.test.ts` (new)

**Interfaces:**
- Produces: `export type View = 'simple' | 'advanced'` (in `src/model/types.ts`); `UiState.view: View`; `Options.advanced: boolean`; `KEY_VIEW = 'v'`; `KeyActions.view(): void`; `viewAction(ctx: Pick<ActionCtx, 'ui' | 'redraw'>): void`.

- [ ] **Step 1: Write the failing test** — create `tests/view-keys.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { dispatchKey, KEY_VIEW, type KeyActions } from '../src/ui/keys';
import { viewAction } from '../src/app/actions';
import { parseArgs, usage } from '../src/cli/args';
import type { UiState } from '../src/model/types';

const env = { env: { HOME: '/Users/test' }, now: new Date(2026, 8, 6, 14, 32, 7) };

const ui = (o: Partial<UiState> = {}): UiState => ({
  view: 'simple', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null, ...o,
});

function spy(): { calls: string[]; actions: KeyActions } {
  const calls: string[] = [];
  const actions: KeyActions = {
    quit: () => calls.push('quit'), speed: () => calls.push('speed'), bell: () => calls.push('bell'),
    portal: () => calls.push('portal'), view: () => calls.push('view'),
  };
  return { calls, actions };
}

test('v dispatches the view action; unknown keys are still ignored', () => {
  const { calls, actions } = spy();
  expect(KEY_VIEW).toBe('v');
  expect(dispatchKey('v', actions)).toBe(true);
  expect(dispatchKey('V', actions)).toBe(false);
  expect(dispatchKey('x', actions)).toBe(false);
  expect(calls).toEqual(['view']);
});

test('viewAction toggles simple <-> advanced and repaints each time', () => {
  const state = ui();
  let redraws = 0;
  const ctx = { ui: state, redraw: () => { redraws++; } };
  viewAction(ctx);
  expect([state.view, redraws]).toEqual(['advanced', 1]);
  viewAction(ctx);
  expect([state.view, redraws]).toEqual(['simple', 2]);
});

test('--advanced: off by default, on when given, takes no value', () => {
  expect(parseArgs([], env).advanced).toBe(false);
  expect(parseArgs(['--advanced'], env).advanced).toBe(true);
  expect(() => parseArgs(['--advanced=1'], env)).toThrow('--advanced does not take a value');
});

test('usage() documents --advanced and the v key', () => {
  const u = usage();
  expect(u).toContain('--advanced');
  expect(u).toContain('v simple/advanced view');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/view-keys.test.ts`
Expected: FAIL (`KEY_VIEW` / `viewAction` not exported, `advanced` undefined).

- [ ] **Step 3: Implement**

`src/model/types.ts` — directly above `export interface UiState {` add:

```ts
/** Which TUI screen is drawn (simple-view spec §2): 'simple' by default, 'advanced' with --advanced; `v` toggles. */
export type View = 'simple' | 'advanced';
```

and add as the first field of `UiState`:

```ts
  view: View;
```

`src/cli/types.ts` — after the `plain` field add:

```ts
  advanced: boolean; // --advanced: start in the advanced (detailed) view
```

`src/cli/args.ts`:
- `BOOL_FLAGS`: add `'--advanced': 'advanced',`.
- Defaults object: `plain: false, advanced: false, ascii: false, ...`.
- The bool branch: `if (boolKey === 'plain' || boolKey === 'advanced' || boolKey === 'ascii' || boolKey === 'help') o[boolKey] = true;`
- `usage()`: after the `--plain` line add `'  --advanced           start in the detailed view (default: the simple view)',` and change the keys line to `'Keys: q quit · t speed test (250 KB) · b bell on/off · o open portal · v simple/advanced view',`.

`src/ui/keys.ts`:
- `KeyActions`: add `view(): void; // v — switch simple/advanced view`.
- Add `export const KEY_VIEW = 'v';`.
- `dispatchKey`: add before `default:`

```ts
    case KEY_VIEW:
      actions.view();
      return true;
```

`src/app/actions.ts` — append:

```ts
/** `v`: switch between the simple and advanced views (simple-view spec §2); repaints at once. */
export function viewAction(ctx: Pick<ActionCtx, 'ui' | 'redraw'>): void {
  ctx.ui.view = ctx.ui.view === 'simple' ? 'advanced' : 'simple';
  ctx.redraw();
}
```

`src/main.ts`:
- Import `viewAction` alongside `bellAction`.
- In `enterTui`'s `bindKeys` object add `view: () => viewAction(ctx),`.
- `UiState` literal: add `view: opts.advanced ? 'advanced' : 'simple',` as its first field.

Fixtures (these sections render the advanced view): add `view: 'advanced', ` as the first property of the `UiState` literal in `tests/sections-b.test.ts` (the `ui` helper), `tests/sections-b2.test.ts` (the `ui` helper), `tests/sections-a.fixture.ts` (`ui()`), and `scripts/render-once.ts` (`const ui`). In `tests/args.test.ts` 'defaults (§12)' and the `OPTS` literal in `tests/app-probes.test.ts`, add `advanced: false,` after `plain: false,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/model/types.ts src/cli/types.ts src/cli/args.ts src/ui/keys.ts src/app/actions.ts src/main.ts tests/view-keys.test.ts tests/sections-b.test.ts tests/sections-b2.test.ts tests/sections-a.fixture.ts tests/args.test.ts tests/app-probes.test.ts scripts/render-once.ts
git commit -m "feat(ui): view state, --advanced flag and v key" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 2: Extract the hop model from `path.ts` into `hops.ts`

Pure refactor: behaviour unchanged; the existing PATH tests in `tests/sections-a.test.ts` are the safety net.

**Files:**
- Create: `src/ui/sections/hops.ts`
- Modify: `src/ui/sections/path.ts` (rewrite as below)
- Test: `tests/hops.test.ts` (new)

**Interfaces:**
- Produces: `export type Detail = 'full' | 'compact' | 'short' | 'abbrev'`; `export interface Hop { name; mark: Mark; detail; compact?; short?; abbr?; color?: ColorName }`; `export function hopList(snap: Snapshot, g: Glyphs): Hop[]`; `export function hopDetail(h: Hop, level: Detail): string`.

- [ ] **Step 1: Write the failing test** — create `tests/hops.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { hopDetail, hopList } from '../src/ui/sections/hops';
import { glyphs } from '../src/ui/ansi';
import { makeHttp, makeRoute, makeSignals, makeSnapshot, NOW } from './helpers/snapshot';

const G = glyphs(false);

test('hopList: the five mockup hops, all ok', () => {
  const hops = hopList(makeSnapshot(), G);
  expect(hops.map((h) => [h.name, h.mark])).toEqual([
    ['Wi-Fi', 'ok'], ['Router', 'ok'], ['Internet', 'ok'], ['DNS', 'ok'], ['Web', 'ok'],
  ]);
});

test('hopList hides Wi-Fi off the egress link and Router without a pingable gateway', () => {
  const hops = hopList(makeSnapshot({ wifiStatus: 'off', route: makeRoute({ pingGateway: null }) }), G);
  expect(hops.map((h) => h.name)).toEqual(['Internet', 'DNS', 'Web']);
});

test('hopDetail: a failing internet hop keeps its detail at compact level', () => {
  const down = makeSnapshot({
    state: 'DOWN', cause: 'uplink',
    signals: makeSignals({ inetLink: 'down', inetOk: false, inetDownSince: NOW - 42000 }),
    http: makeHttp({ kind: 'fail', exitCode: 7, code: null }),
  });
  const inet = hopList(down, G).find((h) => h.name === 'Internet');
  expect(inet?.mark).toBe('fail');
  expect(inet && hopDetail(inet, 'compact')).toBe('no reply 42s');
  expect(inet && hopDetail(inet, 'short')).toBe('42s');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hops.test.ts`
Expected: FAIL (module `../src/ui/sections/hops` not found).

- [ ] **Step 3: Create `src/ui/sections/hops.ts`**

```ts
// §8.1 hop model, shared by the PATH row (path.ts) and the simple view's chain (chain.ts):
// Wi-Fi → Router → Internet → DNS → Web, each with a mark and its detail at several lengths. Pure.
import { BIN, RSSI_WIFI_DOWN, TIP_WEAK_RSSI } from '../../config';
import { fmtMs } from '../../core/format';
import type { Aged, Snapshot } from '../../model/types';
import type { DnsResult, HttpResult } from '../../probes/types';
import type { ColorName, Glyphs } from '../ansi';
import type { Mark } from './common';

/** How much of each hop is rendered. */
export type Detail = 'full' | 'compact' | 'short' | 'abbrev';

export interface Hop {
  name: string;
  mark: Mark;
  detail: string; // full layout
  compact?: string; // compact layout (default: '' for ok/unknown, detail otherwise)
  short?: string; // tightest failure detail (default: the compact one)
  abbr?: string; // shortest name (default: name)
  color?: ColorName; // override (portal → magenta)
}
```

Then move, **verbatim and in this order**, these functions from the current `src/ui/sections/path.ts` into `hops.ts` (keep their comments): `wifiHop` (lines 27–44), `routerHop` (46–54), `inetHop` (56–81), `dnsMs` (83–85), `dnsFail` (87–90), `dnsHop` (92–114), `failWord` (116–127), `webHop` (129–140). Then append:

```ts
/** The hops present for this snapshot, in path order (Wi-Fi / Router hidden when not applicable). */
export function hopList(snap: Snapshot, g: Glyphs): Hop[] {
  return [wifiHop(snap, g), routerHop(snap), inetHop(snap), dnsHop(snap, g), webHop(snap)]
    .filter((h): h is Hop => h !== null);
}

export function hopDetail(h: Hop, level: Detail): string {
  const healthy = h.mark === 'ok' || h.mark === 'unknown';
  if (level === 'full') return h.detail;
  if (level === 'compact') return h.compact ?? (healthy ? '' : h.detail);
  return h.short ?? h.compact ?? (healthy ? '' : h.detail);
}
```

- [ ] **Step 4: Rewrite `src/ui/sections/path.ts`** to exactly:

```ts
// §8.1 hop chain: `PATH  Wi-Fi ✔ -72dBm → Router ✔ 7ms → Internet ✔ 48ms → DNS ✔ 31ms (sys 380) → Web ✔ 200 OK`.
// Compact drops the detail of healthy hops (`Wi-Fi ✔ → Router ✔ → … → Web ✔`); failures keep theirs.
// The hop model lives in hops.ts (shared with the simple view's chain).
import { fit, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import { GLYPHS, type Glyphs } from '../ansi';
import { LEAD, markColor, markGlyph, paint, type SectionPlan } from './common';
import { hopDetail, hopList, type Detail, type Hop } from './hops';

/** path() steps down this ladder until the row fits (never truncates a hop). */
const LADDER: Readonly<Record<'full' | 'compact', readonly Detail[]>> = {
  full: ['full', 'compact', 'short', 'abbrev'],
  compact: ['compact', 'short', 'abbrev'],
};

function renderHop(h: Hop, level: Detail, g: Glyphs, on: boolean): string {
  const mark = paint(h.color ?? markColor(h.mark), markGlyph(h.mark, g), on);
  const name = level === 'abbrev' ? h.abbr ?? h.name : h.name;
  const detail = hopDetail(h, level);
  return `${name} ${mark}${detail ? ` ${detail}` : ''}`;
}

/** Last resort: as many whole hops as fit, so the row never ends on a dangling arrow. */
function keepWholeHops(parts: string[], head: string, sep: string, w: number): string {
  let out = head;
  for (const [i, p] of parts.entries()) {
    const next = i === 0 ? out + p : out + sep + p;
    if (visibleWidth(next) > w) break;
    out = next;
  }
  return fit(out, w);
}

/** One row, exactly `plan.cols` cells; hop detail is shed before anything is cut. */
export function path(snap: Snapshot, plan: SectionPlan, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const hops = hopList(snap, g);
  const head = `${LEAD}PATH  `;
  const sep = ` ${g.arrow} `;
  let parts: string[] = [];
  for (const level of LADDER[plan.compact ? 'compact' : 'full']) {
    parts = hops.map((h) => renderHop(h, level, g, colorOn));
    const line = head + parts.join(sep);
    if (visibleWidth(line) <= plan.cols) return [fit(line, plan.cols)];
  }
  return [keepWholeHops(parts, head, sep, plan.cols)];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS (including every existing PATH test), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/sections/hops.ts src/ui/sections/path.ts tests/hops.test.ts
git commit -m "refactor(ui): extract the hop model from path.ts into hops.ts" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 3: Simple layout planner

**Files:**
- Create: `src/ui/layout-simple.ts`
- Modify: `src/config.ts` (constants), `src/ui/layout.ts` (SectionId, LayoutPlan, tooSmallMessage), `src/ui/frame.ts` (cut the message to `cols`)
- Modify: `tests/layout-frame.test.ts:89,198,202` (new advanced too-small message)
- Test: `tests/layout-simple.test.ts` (new)

**Interfaces:**
- Consumes: `View` (Task 1).
- Produces: `SectionId` gains `'status' | 'chips' | 'chain' | 'chart'`; `LayoutPlan.view: View`, `LayoutPlan.chartRows: number`; `planSimpleLayout(size: Size): LayoutPlan`; `simpleTimeline(cols: number): { cells: number; cellMs: number }`; `tooSmallMessage(p: Size & { view?: View }): string`; config `SIMPLE_MIN_COLS`, `SIMPLE_MIN_ROWS`, `CHART_MIN_ROWS`, `CHART_MAX_ROWS`, `TIMELINE_LABEL_W`.

- [ ] **Step 1: Write the failing test** — create `tests/layout-simple.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { planSimpleLayout, simpleTimeline } from '../src/ui/layout-simple';
import { planLayout, slotFor, tooSmallMessage, type LayoutPlan } from '../src/ui/layout';
import { composeLines } from '../src/ui/frame';

function occupied(plan: LayoutPlan): number[] {
  const rows: number[] = [...plan.rules];
  for (const s of plan.slots) for (let i = 0; i < s.rows; i++) rows.push(s.row + i);
  return rows.sort((a, b) => a - b);
}

function expectSane(plan: LayoutPlan): void {
  const occ = occupied(plan);
  expect(new Set(occ).size).toBe(occ.length);
  for (const r of occ) expect(r >= 1 && r <= plan.rows).toBe(true);
  expect(slotFor(plan, 'footer')?.row).toBe(plan.rows);
  expect(plan.chartRows).toBeLessThanOrEqual(14);
}

const ALL = ['header', 'status', 'chips', 'chain', 'chart', 'timeline', 'tip', 'footer'];

test('80x24: every section, six spacers, chart 7', () => {
  const p = planSimpleLayout({ cols: 80, rows: 24 });
  expect([p.view, p.tooSmall]).toEqual(['simple', false]);
  expect(p.sections).toEqual(ALL);
  expect(p.chartRows).toBe(7);
  expect(p.rules).toEqual([2, 5, 8, 10, 18, 22]);
  expect(slotFor(p, 'chart')).toEqual({ id: 'chart', row: 11, rows: 7 });
  expect(slotFor(p, 'timeline')).toEqual({ id: 'timeline', row: 19, rows: 3 });
  expectSane(p);
});

test('100x30: chart takes the leftover rows (13)', () => {
  const p = planSimpleLayout({ cols: 100, rows: 30 });
  expect(p.chartRows).toBe(13);
  expect(p.rules).toEqual([2, 5, 8, 10, 24, 28]);
  expectSane(p);
});

test('60x15: chart at its minimum, no spacers', () => {
  const p = planSimpleLayout({ cols: 60, rows: 15 });
  expect(p.sections).toEqual(ALL);
  expect([p.chartRows, p.rules]).toEqual([4, []]);
  expectSane(p);
});

test('40x10: no chart, no tip, no spacers', () => {
  const p = planSimpleLayout({ cols: 40, rows: 10 });
  expect(p.sections).toEqual(['header', 'status', 'chips', 'chain', 'timeline', 'footer']);
  expect([p.chartRows, p.rules]).toEqual([0, []]);
  expectSane(p);
});

test('160x50: chart capped at 14, the rest stays blank above the footer', () => {
  const p = planSimpleLayout({ cols: 160, rows: 50 });
  expect(p.chartRows).toBe(14);
  expect(slotFor(p, 'tip')?.row).toBe(30);
  expectSane(p);
});

test('below 40x10 only the message is shown', () => {
  for (const size of [{ cols: 39, rows: 10 }, { cols: 40, rows: 9 }]) {
    const p = planSimpleLayout(size);
    expect([p.tooSmall, p.slots]).toEqual([true, []]);
    expect(tooSmallMessage(p)).toBe('too small (need 40x10)');
    expect(composeLines(p, {}, '')[0]).toBe('too small (need 40x10)');
  }
});

test('advanced plan: view advanced, no chart; its too-small message points at v', () => {
  const p = planLayout({ cols: 60, rows: 15 });
  expect([p.view, p.chartRows, p.tooSmall]).toEqual(['advanced', 0, true]);
  expect(tooSmallMessage(p)).toBe('details need 72x18 (have 60x15); press v');
});

test('simpleTimeline: fills the row up to 90 cells, always ~15 minutes', () => {
  expect(simpleTimeline(40)).toEqual({ cells: 30, cellMs: 30000 });
  expect(simpleTimeline(80)).toEqual({ cells: 70, cellMs: 12857 });
  expect(simpleTimeline(100)).toEqual({ cells: 90, cellMs: 10000 });
  expect(simpleTimeline(160)).toEqual({ cells: 90, cellMs: 10000 });
});

test('every size from 40x10 to 160x50 plans without overlap', () => {
  for (let cols = 40; cols <= 160; cols += 13) {
    for (let rows = 10; rows <= 50; rows++) expectSane(planSimpleLayout({ cols, rows }));
  }
});

test('spacer rows compose as blank lines', () => {
  const p = planSimpleLayout({ cols: 80, rows: 24 });
  const lines = composeLines(p, { header: ['H'], status: ['S1', 'S2'], footer: ['F'] }, '');
  expect([lines[0], lines[1], lines[2], lines[23]]).toEqual(['H', '', 'S1', 'F']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/layout-simple.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/config.ts` — after `TIMELINE_COMPACT` add:

```ts
// simple-view spec §3 (docs/superpowers/specs/2026-10-02-simple-view-design.md)
export const SIMPLE_MIN_COLS = 40;
export const SIMPLE_MIN_ROWS = 10;
export const CHART_MIN_ROWS = 4; // caption + 3 plot rows
export const CHART_MAX_ROWS = 14;
export const TIMELINE_LABEL_W = 10; // ` LAST 15m `
```

`src/ui/layout.ts`:
- Imports: add `SIMPLE_MIN_COLS, SIMPLE_MIN_ROWS` to the config import and `import type { View } from '../model/types';`.
- `SectionId`: append `| 'status' | 'chips' | 'chain' | 'chart'`.
- Add `type AdvancedId = Exclude<SectionId, 'status' | 'chips' | 'chain' | 'chart'>;` and change `PRIORITY`, `DISPLAY`, `RULES_FULL`, `RULES_COMPACT` to `readonly AdvancedId[]`, `rowsNeeded` to return `Record<AdvancedId, number>`, and `new Set<SectionId>()` for `placed`/`ruleAfter` to `new Set<AdvancedId>()`.
- `LayoutPlan`: add `view: View; // which screen this plan is for` and `chartRows: number; // simple view: caption + plot rows; 0 otherwise`.
- `planLayout`'s plan literal: add `view: 'advanced', chartRows: 0,`.
- Replace `tooSmallMessage` with:

```ts
/** The single-line frame below a view's minimum (§8.2; simple-view spec §3). ASCII; ≤ 40 cells. */
export function tooSmallMessage(p: Size & { view?: View }): string {
  if (p.view === 'simple') return `too small (need ${SIMPLE_MIN_COLS}x${SIMPLE_MIN_ROWS})`;
  return `details need ${MIN_COLS}x${MIN_ROWS} (have ${p.cols}x${p.rows}); press v`;
}
```

`src/ui/frame.ts` — `composeLines` must never return a line wider than the terminal: import `truncate` alongside `fit` and change `if (plan.rows > 0) lines[0] = tooSmallMessage(plan);` to `if (plan.rows > 0) lines[0] = truncate(tooSmallMessage(plan), plan.cols);`.

Create `src/ui/layout-simple.ts`:

```ts
// Simple-view layout (simple-view spec §3). Pure: terminal size in, section placement out.
import {
  CHART_MAX_ROWS, CHART_MIN_ROWS, FULL_COLS, SIMPLE_MIN_COLS, SIMPLE_MIN_ROWS, TIMELINE_FULL,
  TIMELINE_LABEL_W, WIN_HISTORY_MS,
} from '../config';
import type { LayoutPlan, Size } from './layout';

type SimpleId = 'header' | 'status' | 'chips' | 'chain' | 'chart' | 'timeline' | 'tip' | 'footer';

const NEED: Readonly<Record<SimpleId, number>> = {
  header: 1, status: 2, chips: 2, chain: 1, chart: CHART_MIN_ROWS, timeline: 3, tip: 1, footer: 1,
};
/** Placement priority: a section is placed when its rows still fit. */
const PRIORITY: readonly SimpleId[] = ['header', 'status', 'chips', 'footer', 'timeline', 'chain', 'chart', 'tip'];
/** Screen order, top → bottom (footer pinned to the last row). */
const DISPLAY: readonly SimpleId[] = ['header', 'status', 'chips', 'chain', 'chart', 'timeline', 'tip', 'footer'];
/** A blank spacer row goes below each of these (when placed), top to bottom, while rows remain. */
const SPACER_AFTER: readonly SimpleId[] = ['header', 'status', 'chips', 'chain', 'chart', 'timeline'];

/** Timeline cells for a row width: the bar fills the row (at most 90 cells) and spans 15 minutes. */
export function simpleTimeline(cols: number): { cells: number; cellMs: number } {
  const cells = Math.max(1, Math.min(TIMELINE_FULL.cells, cols - TIMELINE_LABEL_W));
  return { cells, cellMs: Math.round(WIN_HISTORY_MS / cells) };
}

export function planSimpleLayout(size: Size): LayoutPlan {
  const cols = Math.max(0, Math.floor(size.cols));
  const rows = Math.max(0, Math.floor(size.rows));
  const tooSmall = cols < SIMPLE_MIN_COLS || rows < SIMPLE_MIN_ROWS;
  const tl = simpleTimeline(cols);
  const plan: LayoutPlan = {
    view: 'simple', cols, rows, tooSmall, compact: cols < FULL_COLS, sections: [], slots: [], rules: [],
    timelineCells: tl.cells, cellMs: tl.cellMs, activitiesRows: 0, dropsRows: 0, chartRows: 0,
  };
  if (tooSmall) return plan;

  const need: Record<SimpleId, number> = { ...NEED };
  const placed = new Set<SimpleId>();
  let free = rows;
  for (const id of PRIORITY) {
    if (need[id] <= free) {
      placed.add(id);
      free -= need[id];
    }
  }
  const spacerAfter = new Set<SimpleId>();
  for (const id of SPACER_AFTER) {
    if (free <= 0) break;
    if (!placed.has(id)) continue;
    spacerAfter.add(id);
    free -= 1;
  }
  if (placed.has('chart')) {
    const grow = Math.min(free, CHART_MAX_ROWS - CHART_MIN_ROWS);
    need.chart += grow;
    free -= grow;
  }

  let row = 1;
  for (const id of DISPLAY) {
    if (!placed.has(id)) continue;
    if (id === 'footer') {
      plan.slots.push({ id, row: rows, rows: 1 });
      continue;
    }
    plan.slots.push({ id, row, rows: need[id] });
    row += need[id];
    if (spacerAfter.has(id)) plan.rules.push(row++);
  }
  plan.sections = plan.slots.map((s) => s.id);
  plan.chartRows = placed.has('chart') ? need.chart : 0;
  return plan;
}
```

`tests/layout-frame.test.ts`: replace the three occurrences of `'terminal too small (need 72x18, have 60x16)'` with `'details need 72x18 (have 60x16); press v'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/ui/layout.ts src/ui/layout-simple.ts src/ui/frame.ts tests/layout-simple.test.ts tests/layout-frame.test.ts
git commit -m "feat(ui): simple-view layout planner" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 4: Status block and simple header

**Files:**
- Create: `src/ui/sections/status.ts`
- Modify: `src/ui/sections/common.ts` (add `shedRight`, `ellipsize`), `src/ui/sections/banner.ts:9` (export `causeLabel`), `src/ui/sections/header.ts` (add `simpleHeader`)
- Test: `tests/simple-status.test.ts` (new)

**Interfaces:**
- Produces: `shedRight(segs: string[], sep: string, w: number): string`; `ellipsize(s: string, w: number, g: Glyphs): string`; `badge(snap, g, on, flash): string`; `statusSegments(snap, g, on, flash?): string[]`; `status(snap: Snapshot, ui: UiState, w: number, g: Glyphs, on: boolean): string[]` (2 rows); `simpleHeader(snap: Snapshot, w: number, g?: Glyphs, colorOn?: boolean): string[]` (1 row).

- [ ] **Step 1: Write the failing test** — create `tests/simple-status.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { status } from '../src/ui/sections/status';
import { simpleHeader } from '../src/ui/sections/header';
import { ellipsize, shedRight } from '../src/ui/sections/common';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { FLAT_TREND, makeGrade, makeRoute, makeSnapshot } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ui = (o: Partial<UiState> = {}): UiState => ({
  view: 'simple', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null, ...o,
});
const SENTENCE = 'Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no (3 drops/15m).';

test('shedRight keeps whole segments from the left; ellipsize marks a cut', () => {
  expect(shedRight(['aa', 'bb', 'cc'], ' | ', 7)).toBe('aa | bb');
  expect(shedRight(['toolong'], ' | ', 3)).toBe('toolong'); // the first segment is never shed
  expect(ellipsize('abcdef', 4, G)).toBe('abc…');
  expect(ellipsize('abc', 4, G)).toBe('abc');
  expect(ellipsize('abcdef', 5, A)).toBe('ab...');
});

test('status UP: badge, grade, steady, trend; sentence on row 2', () => {
  const rows = status(makeSnapshot({ banner: ['', SENTENCE] }), ui(), 100, G, false);
  expect(rows.map((r) => visibleWidth(r))).toEqual([100, 100]);
  expect(rows[0]?.trimEnd()).toBe('  ● UP   OK (B)   steady 4m12s   getting worse ▲');
  expect(rows[1]?.trimEnd()).toBe(`  ${SENTENCE}`);
});

test('status sheds row-1 segments from the right and ellipsizes the sentence', () => {
  const rows = status(makeSnapshot({ banner: ['', SENTENCE] }), ui(), 40, G, false);
  expect(rows[0]?.trimEnd()).toBe('  ● UP   OK (B)   steady 4m12s');
  expect(rows[1]?.endsWith('…')).toBe(true);
  expect(visibleWidth(rows[1] ?? '')).toBe(40);
});

test('status DOWN: cause and outage clock, no grade', () => {
  const snap = makeSnapshot({ state: 'DOWN', cause: 'uplink', downFor: 42, grade: makeGrade({ grade: null }), trend: FLAT_TREND });
  expect(status(snap, ui(), 80, G, false)[0]?.trimEnd()).toBe('  ● DOWN   uplink   DOWN 0:42');
});

test('status with color: the badge is an inverse colored block; flash inverts the row instead', () => {
  const on = status(makeSnapshot(), ui(), 80, G, true)[0] ?? '';
  expect(on).toContain('\x1b[7m\x1b[1m\x1b[32m UP \x1b[39m\x1b[22m\x1b[27m');
  const flash = status(makeSnapshot(), ui({ flashTicksLeft: 2 }), 80, G, true)[0] ?? '';
  expect(flash.startsWith('\x1b[7m')).toBe(true);
  expect(flash.split('\x1b[7m').length - 1).toBe(1); // only the row's own inverse
});

test('status without color keeps the state readable (● UP / * UP in ascii)', () => {
  expect(strip(status(makeSnapshot(), ui(), 80, A, false)[0] ?? '')).toContain('* UP');
  expect(status(makeSnapshot(), ui(), 80, G, false)[0]).not.toContain('\x1b[');
});

test('simpleHeader: name, link and clock only', () => {
  const [h] = simpleHeader(makeSnapshot(), 80, G, false);
  expect(visibleWidth(h ?? '')).toBe(80);
  expect(h?.startsWith(' netmon  Wi-Fi (en1)')).toBe(true);
  expect(h?.endsWith('14:32:07')).toBe(true);
  expect(h).not.toContain('gw ');
  const [eth] = simpleHeader(makeSnapshot({ wifiStatus: 'off', route: makeRoute({ egressIface: 'en7' }) }), 80, G, false);
  expect(eth?.startsWith(' netmon  en7 ')).toBe(true);
  expect(eth).not.toContain('Wi-Fi');
  const [vpn] = simpleHeader(makeSnapshot({ vpn: true }), 80, G, false);
  expect(vpn).toContain('Wi-Fi (en1) · vpn');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-status.test.ts`
Expected: FAIL (`status` module / `simpleHeader` / `shedRight` missing).

- [ ] **Step 3: Implement**

`src/ui/sections/common.ts` — add `truncate, visibleWidth` import from `'../../core/format'` and append:

```ts
/** Whole segments from the left, joined by sep, while they fit in w (the first is always kept). */
export function shedRight(segs: string[], sep: string, w: number): string {
  let out = '';
  for (const [i, s] of segs.entries()) {
    const next = i === 0 ? s : out + sep + s;
    if (i > 0 && visibleWidth(next) > w) break;
    out = next;
  }
  return out;
}

/** Cut to w cells, ending in the ellipsis glyph when anything was cut. */
export function ellipsize(s: string, w: number, g: Glyphs): string {
  if (visibleWidth(s) <= w) return s;
  return truncate(s, Math.max(0, w - visibleWidth(g.ellipsis))) + g.ellipsis;
}
```

`src/ui/sections/banner.ts`: change `function causeLabel(` to `export function causeLabel(`.

Create `src/ui/sections/status.ts`:

```ts
// Simple-view status block (simple-view spec §4): a colored state badge, then grade / timer / trend
// segments shed from the right, then the §7.5 sentence. Inverse for FLASH_TICKS after a transition. Pure.
import { GRADE_WORDS } from '../../config';
import { fit, fmtClock, fmtDuration } from '../../core/format';
import { isOffline, type Snapshot, type UiState } from '../../model/types';
import { color, type Glyphs } from '../ansi';
import { causeLabel } from './banner';
import { LEAD, ellipsize, gradeColor, paint, shedRight, stateColor, stateWord } from './common';

const GAP = '   ';

/** ` UP ` as a bold block in the state color (inverse); `● UP` without color. */
export function badge(snap: Snapshot, g: Glyphs, on: boolean, flash: boolean): string {
  const word = stateWord(snap.state);
  if (!on) return `${g.bullet} ${word}`;
  const text = color('bold', paint(stateColor(snap.state), ` ${word} `, on), on);
  return flash ? text : color('inverse', text, on); // a flashing row is already inverse
}

/** Row-1 segments in shedding order; the badge is never shed. */
export function statusSegments(snap: Snapshot, g: Glyphs, on: boolean, flash = false): string[] {
  const segs = [badge(snap, g, on, flash)];
  const cause = causeLabel(snap);
  if (cause) segs.push(cause);
  const graded = snap.state === 'UP' || snap.state === 'DEGRADED';
  const gr = snap.grade.grade;
  if (gr && graded) {
    const tilde = snap.grade.underLoad ? '~' : ''; // §4.8
    segs.push(paint(gradeColor(gr), `${GRADE_WORDS[gr]} (${gr}${tilde})`, on));
  }
  if (graded) {
    segs.push(`steady ${fmtDuration(snap.steadyFor)}`);
  } else if (isOffline(snap.state)) {
    const secs = snap.downFor ?? (snap.now - snap.since) / 1000;
    segs.push(paint(stateColor(snap.state), `${stateWord(snap.state)} ${fmtClock(secs)}`, on));
  }
  const t = snap.trend;
  if (t.phrase && t.overall) {
    const worse = t.overall === 'worse';
    segs.push(paint(worse ? 'yellow' : 'green', `${t.phrase} ${worse ? g.up : g.down}`, on));
  }
  if (snap.grade.tags.includes('FLAKY')) segs.push(paint('yellow', 'FLAKY', on));
  if (snap.sat) segs.push(`sat +${snap.rttOffset}ms`);
  if (snap.grade.underLoad) segs.push('~ under load');
  return segs;
}

/** Two rows, exactly `w` cells each. */
export function status(snap: Snapshot, ui: UiState, w: number, g: Glyphs, on: boolean): string[] {
  const flash = ui.flashTicksLeft > 0;
  const room = w - LEAD.length;
  const rows = [
    LEAD + shedRight(statusSegments(snap, g, on, flash), GAP, room),
    LEAD + ellipsize(snap.banner[1], room, g),
  ];
  return rows.map((s) => (flash ? color('inverse', fit(s, w), on) : fit(s, w)));
}
```

`src/ui/sections/header.ts` — append:

```ts
/** Simple view (simple-view spec §4): ` netmon  Wi-Fi (en1) · vpn`, clock right-aligned. */
export function simpleHeader(snap: Snapshot, w: number, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const iface = snap.route?.egressIface ?? g.em;
  const link = snap.wifiStatus === 'off' ? iface : `Wi-Fi (${iface})`;
  const left = ' ' + color('bold', 'netmon', colorOn) + '  ' + link + (snap.vpn ? ` ${g.sep} vpn` : '');
  const right = fmtTime(snap.wall);
  const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
  return [fit(left + ' '.repeat(gap) + right, w)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sections/common.ts src/ui/sections/banner.ts src/ui/sections/status.ts src/ui/sections/header.ts tests/simple-status.test.ts
git commit -m "feat(ui): simple-view status badge and header" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 5: Activity chips

**Files:**
- Create: `src/ui/sections/chips.ts`
- Modify: `src/config.ts` (add `CHIPS_GRID_COLS`)
- Test: `tests/simple-chips.test.ts` (new)

**Interfaces:**
- Consumes: `ellipsize` (Task 4), `levelMark`, `markColor`, `markGlyph`, `paint`, `LEAD` from `common.ts`.
- Produces: `chips(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[]` (2 rows); `cutReason(reason: string, w: number, g: Glyphs): string`.

- [ ] **Step 1: Write the failing test** — create `tests/simple-chips.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { chips, cutReason } from '../src/ui/sections/chips';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { allOkVerdicts, makeSnapshot, makeVerdicts } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;

test('80 cols: four 19-cell columns, reasons cut at a " · " under non-OK chips', () => {
  const [top, under] = chips(makeSnapshot(), 80, G, false).map(strip);
  expect([visibleWidth(top ?? ''), visibleWidth(under ?? '')]).toEqual([80, 80]);
  expect([top?.indexOf('✔ Chat'), top?.indexOf('✔ Browse'), top?.indexOf('~ Video call'), top?.indexOf('✘ Download')]).toEqual([2, 21, 40, 59]);
  expect(under?.slice(0, 40).trim()).toBe('');
  expect(under?.indexOf('jitter 71ms')).toBe(40);
  expect(under).not.toContain('audio ok');
  expect(under?.indexOf('3 drops/15m')).toBe(59);
});

test('100 cols: the whole reason fits its 24-cell column', () => {
  const [, under] = chips(makeSnapshot(), 100, G, false);
  expect(under).toContain('jitter 71ms · audio ok');
});

test('Video call shortens to Video only when the full chip does not fit its column', () => {
  expect(chips(makeSnapshot(), 54, G, false)[0]).toContain('~ Video call');
  const [t53] = chips(makeSnapshot(), 53, G, false);
  expect(t53).toContain('~ Video ');
  expect(t53).not.toContain('Video call');
});

test('below 50 cols: a 2x2 grid with no reasons', () => {
  const [r0, r1] = chips(makeSnapshot(), 49, G, false);
  expect([r0?.indexOf('✔ Chat'), r0?.indexOf('✔ Browse')]).toEqual([2, 25]);
  expect([r1?.indexOf('~ Video call'), r1?.indexOf('✘ Download')]).toEqual([2, 25]);
  expect(r1).not.toContain('jitter');
  const [n0, n1] = chips(makeSnapshot(), 40, G, false);
  expect([n0?.trimEnd(), n1?.trimEnd()]).toEqual(['  ' + '✔ Chat'.padEnd(19) + '✔ Browse', '  ' + '~ Video call'.padEnd(19) + '✘ Download']);
});

test('ascii at 50 cols: chips never touch and stay ASCII', () => {
  const rows = chips(makeSnapshot({ verdicts: allOkVerdicts() }), 50, A, false);
  for (const r of rows) expect([visibleWidth(r), ASCII_RE.test(r)]).toEqual([50, true]);
  expect(rows[0]?.indexOf('OK Download')).toBe(38);
  expect(rows[0]?.[37]).toBe(' ');
});

test('chips carry the verdict colors; reasons are dim', () => {
  const [top, under] = chips(makeSnapshot(), 80, G, true);
  expect(top).toContain('\x1b[32m✔ Chat\x1b[39m');
  expect(top).toContain('\x1b[33m~ Video call\x1b[39m');
  expect(top).toContain('\x1b[31m✘ Download\x1b[39m');
  expect(under).toContain('\x1b[2mjitter 71ms\x1b[22m');
  const unknown = chips(makeSnapshot({ verdicts: makeVerdicts({ CHAT: { level: '?' } }) }), 80, G, true)[0];
  expect(unknown).toContain('\x1b[2m? Chat\x1b[22m');
});

test('cutReason: whole when it fits, at a separator, else ellipsized', () => {
  expect(cutReason('3 drops/15m', 18, G)).toBe('3 drops/15m');
  expect(cutReason('jitter 71ms · audio ok', 18, G)).toBe('jitter 71ms');
  expect(cutReason('averyveryverylongreason', 10, G)).toBe('averyvery…');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-chips.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/config.ts` — after `TIMELINE_LABEL_W` add:

```ts
export const CHIPS_GRID_COLS = 50; // below this the four chips form a 2×2 grid
```

Create `src/ui/sections/chips.ts`:

```ts
// Simple-view activity chips (simple-view spec §4): `✔ Chat  ✔ Browse  ~ Video call  ✘ Download` in the
// verdict colors, the binding reason (dim) under each non-OK chip; a 2×2 grid in narrow panes. Pure.
import { CHIPS_GRID_COLS } from '../../config';
import { fit, padEnd, visibleWidth } from '../../core/format';
import type { ActivityName, Snapshot, Verdict } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, ellipsize, levelMark, markColor, markGlyph, paint } from './common';

const NAMES: Readonly<Record<ActivityName, string>> = {
  CHAT: 'Chat', BROWSE: 'Browse', 'VIDEO CALL': 'Video call', DOWNLOAD: 'Download',
};

function chip(v: Verdict, short: boolean, g: Glyphs, on: boolean): string {
  const m = levelMark(v.level);
  const name = short && v.name === 'VIDEO CALL' ? 'Video' : NAMES[v.name];
  return paint(markColor(m), `${markGlyph(m, g)} ${name}`, on);
}

/** The reason cut at the last ` · ` (g.sep) that fits in w, else ellipsized. */
export function cutReason(reason: string, w: number, g: Glyphs): string {
  if (visibleWidth(reason) <= w) return reason;
  const sep = ` ${g.sep} `;
  const parts = reason.split(sep);
  for (let n = parts.length - 1; n >= 1; n--) {
    const s = parts.slice(0, n).join(sep);
    if (visibleWidth(s) <= w) return s;
  }
  return ellipsize(reason, w, g);
}

function grid(vs: Verdict[], w: number, g: Glyphs, on: boolean): string[] {
  const col = Math.floor((w - LEAD.length) / 2);
  const row = (a?: Verdict, b?: Verdict): string =>
    fit(LEAD + (a ? padEnd(chip(a, false, g, on), col) : '') + (b ? chip(b, false, g, on) : ''), w);
  return [row(vs[0], vs[1]), row(vs[2], vs[3])];
}

/** Two rows, exactly `w` cells each. */
export function chips(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const vs = snap.verdicts;
  if (w < CHIPS_GRID_COLS) return grid(vs, w, g, on);
  const col = Math.floor((w - LEAD.length) / 4);
  const short = vs.some((v) => visibleWidth(chip(v, false, g, false)) > col - 1);
  let top = LEAD;
  let under = LEAD;
  for (const v of vs) {
    top += padEnd(chip(v, short, g, on), col);
    const reason = v.level === 'OK' || !v.reason ? '' : paint('dim', cutReason(v.reason, col - 1, g), on);
    under += padEnd(reason, col);
  }
  return [fit(top, w), fit(under, w)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/ui/sections/chips.ts tests/simple-chips.test.ts
git commit -m "feat(ui): simple-view activity chips" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 6: Hop chain

**Files:**
- Create: `src/ui/sections/chain.ts`
- Modify: `src/ui/ansi.ts` (glyphs `dot`, `link`)
- Test: `tests/simple-chain.test.ts` (new)

**Interfaces:**
- Consumes: `hopList`, `hopDetail`, `Hop` (Task 2).
- Produces: `Glyphs.dot` (`●` / `o`), `Glyphs.link` (`─` / `-`); `chain(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[]` (1 row).

- [ ] **Step 1: Write the failing test** — create `tests/simple-chain.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { chain } from '../src/ui/sections/chain';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { makeHttp, makeRoute, makeSignals, makeSnapshot, NOW } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;

const downSnap = () => makeSnapshot({
  state: 'DOWN', cause: 'uplink',
  signals: makeSignals({ inetLink: 'down', inetOk: false, inetDownSince: NOW - 42000 }),
  dnsDirectOk: false, dnsSysOk: false, dnsOk: false,
  http: makeHttp({ kind: 'fail', exitCode: 7, code: null }),
});

test('80 cols, color off: mark glyphs instead of dots, full connectors', () => {
  const [row] = chain(makeSnapshot(), 80, G, false);
  expect(visibleWidth(row ?? '')).toBe(80);
  expect(row?.trimEnd()).toBe('  Wi-Fi ✔──── Router ✔──── Internet ✔──── DNS ✔──── Web ✔');
});

test('color on: green dots, dim connectors', () => {
  const [row] = chain(makeSnapshot(), 80, G, true);
  expect(row?.split('\x1b[32m●\x1b[39m').length).toBe(6);
  expect(row).toContain('\x1b[2m──── \x1b[22m');
});

test('the first failing hop shows its detail; later failures only their dot', () => {
  const [row] = chain(downSnap(), 100, G, false);
  expect(row?.trimEnd()).toBe('  Wi-Fi ✔──── Router ✔──── Internet ✘ no reply 42s ──── DNS ✘──── Web ✘');
});

test('width ladder: 40 cols drops connector spaces and abbreviates Internet', () => {
  const [row] = chain(makeSnapshot(), 40, G, true);
  expect(strip(row ?? '').trimEnd()).toBe('  Wi-Fi ●─Router ●─Inet ●─DNS ●─Web ●');
  for (let w = 40; w <= 120; w++) expect(visibleWidth(chain(downSnap(), w, G, true)[0] ?? '')).toBe(w);
});

test('Ethernet with no pingable gateway: only Internet, DNS, Web', () => {
  const snap = makeSnapshot({ wifiStatus: 'off', route: makeRoute({ pingGateway: null }) });
  expect(chain(snap, 80, G, false)[0]?.trimEnd()).toBe('  Internet ✔──── DNS ✔──── Web ✔');
});

test('portal: magenta dot and detail on the Web hop', () => {
  const [row] = chain(makeSnapshot({ state: 'PORTAL', http: makeHttp({ kind: 'portal' }) }), 80, G, true);
  expect(row).toContain('\x1b[35m●\x1b[39m');
  expect(row).toContain('\x1b[35mportal\x1b[39m');
});

test('ascii, color off: OK marks and dashes, pure ASCII', () => {
  const [row] = chain(makeSnapshot(), 80, A, false);
  expect(row?.trimEnd()).toBe('  Wi-Fi OK---- Router OK---- Internet OK---- DNS OK---- Web OK');
  expect(ASCII_RE.test(row ?? '')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-chain.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/ui/ansi.ts` — in `interface Glyphs`, after `ellipsis`, add:

```ts
  dot: string; // ● simple-view hop dot (colored)
  link: string; // ─ simple-view hop connector
```

and in `GLYPHS`: unicode `dot: '●', link: '─',`; ascii `dot: 'o', link: '-',`.

Create `src/ui/sections/chain.ts`:

```ts
// Simple-view hop chain (simple-view spec §4): `Wi-Fi ●──── Router ●──── Internet ● no reply 42s ──── DNS ●`.
// Same hops as the §8.1 PATH row; colored dots carry the status, mark glyphs replace them without color. Pure.
import { fit, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, markColor, markGlyph, paint } from './common';
import { hopDetail, hopList, type Hop } from './hops';

interface Rung { dashes: number; space: boolean; detail: boolean; abbrev: boolean }

/** Tried in order until the row fits (simple-view spec §4 width ladder). */
const LADDER: readonly Rung[] = [
  { dashes: 4, space: true, detail: true, abbrev: false },
  { dashes: 3, space: true, detail: true, abbrev: false },
  { dashes: 2, space: true, detail: true, abbrev: false },
  { dashes: 1, space: true, detail: true, abbrev: false },
  { dashes: 1, space: false, detail: true, abbrev: false },
  { dashes: 1, space: false, detail: false, abbrev: false },
  { dashes: 1, space: false, detail: false, abbrev: true },
];

const isBad = (h: Hop): boolean => h.mark === 'fail' || h.mark === 'shaky';

function node(h: Hop, detail: string, abbrev: boolean, g: Glyphs, on: boolean): string {
  const c = h.color ?? markColor(h.mark);
  const dot = on ? paint(c, g.dot, on) : markGlyph(h.mark, g);
  const name = abbrev ? h.abbr ?? h.name : h.name;
  return `${name} ${dot}${detail ? ' ' + paint(c, detail, on) : ''}`;
}

function render(hops: Hop[], bad: number, r: Rung, g: Glyphs, on: boolean): string {
  const details = hops.map((h, i) => (r.detail && i === bad ? hopDetail(h, 'compact') : ''));
  let out = LEAD;
  hops.forEach((h, i) => {
    if (i > 0) {
      const afterDetail = (details[i - 1] ?? '') !== '';
      out += paint('dim', (afterDetail ? ' ' : '') + g.link.repeat(r.dashes) + (r.space ? ' ' : ''), on);
    }
    out += node(h, details[i] ?? '', r.abbrev, g, on);
  });
  return out;
}

/** One row, exactly `w` cells. */
export function chain(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const hops = hopList(snap, g);
  const bad = hops.findIndex(isBad);
  let line = LEAD;
  for (const r of LADDER) {
    line = render(hops, bad, r, g, on);
    if (visibleWidth(line) <= w) break;
  }
  return [fit(line, w)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ansi.ts src/ui/sections/chain.ts tests/simple-chain.test.ts
git commit -m "feat(ui): simple-view hop chain" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 7: Latency chart

**Files:**
- Create: `src/ui/sections/chart.ts`
- Modify: `src/ui/ansi.ts` (glyphs `axis`, `eighths`, `full`), `src/ui/sections/common.ts` (add `paintRuns`)
- Test: `tests/simple-chart.test.ts` (new)

**Interfaces:**
- Consumes: `speedText(snap, g)` from `src/ui/sections/metrics-cells.ts` (existing export), `GRADE_TIERS` from config.
- Produces: `Glyphs.axis`, `Glyphs.eighths: readonly string[]` (7 entries), `Glyphs.full`; `paintRuns(chars, colors, on): string`; `niceTop(max: number): number`; `barEighths(v: number, rows: number, top: number): number`; `barColor(v: number, offset: number): ColorName`; `chart(snap: Snapshot, ui: UiState, cols: number, rows: number, g: Glyphs, on: boolean): string[]` (exactly `rows` lines).

- [ ] **Step 1: Write the failing test** — create `tests/simple-chart.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { barColor, barEighths, chart, niceTop } from '../src/ui/sections/chart';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { makeSnapshot } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;
const ui = (o: Partial<UiState> = {}): UiState => ({
  view: 'simple', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null, ...o,
});

test('niceTop: 50, 100, 200, 500, 1000, … never below 50', () => {
  expect([0, 49, 50, 51, 999, 1000, 1001, 12000].map(niceTop)).toEqual([50, 50, 50, 100, 1000, 1000, 2000, 20000]);
  expect([Number.NaN, Number.POSITIVE_INFINITY].map(niceTop)).toEqual([50, 50]);
});

test('barEighths: proportional, at least 1 for a reply, capped at the plot', () => {
  expect([barEighths(100, 4, 200), barEighths(0, 4, 200), barEighths(1, 4, 1000), barEighths(5000, 4, 200)]).toEqual([16, 0, 1, 32]);
});

test('barColor: §7.2 tier bands after the satellite offset', () => {
  expect([300, 301, 800, 801].map((v) => barColor(v, 0))).toEqual(['green', 'yellow', 'yellow', 'red']);
  expect(barColor(650, 400)).toBe('green');
});

test('plot: newest at the right, eighth blocks, x for lost, axis labels', () => {
  const snap = makeSnapshot({ rttHistory: [100, 200, null, 50], speed: null });
  const lines = chart(snap, ui(), 60, 5, G, false);
  expect(lines.length).toBe(5);
  expect(lines[0]?.startsWith('  LATENCY  48ms typical · 86ms peaks')).toBe(true);
  expect(lines[0]?.endsWith('last 4s')).toBe(true);
  expect(lines.slice(1).map((l) => l.trimEnd())).toEqual(['  200┤ █', '     ┤ █', '  100┤██', '     ┤██x█']);
});

test('bar colors per sample; lost samples red', () => {
  // top 1000, 3 plot rows: 100 → 2 eighths (▂), 500 and 900 fill the bottom row
  const bottom = chart(makeSnapshot({ rttHistory: [100, 500, 900], speed: null }), ui(), 60, 4, G, true)[3] ?? '';
  expect(bottom).toContain('\x1b[32m▂\x1b[39m');
  expect(bottom).toContain('\x1b[33m█\x1b[39m');
  expect(bottom).toContain('\x1b[31m█\x1b[39m');
  const lost = chart(makeSnapshot({ rttHistory: [50, null, 50], speed: null }), ui(), 60, 4, G, true)[3] ?? '';
  expect(lost).toContain('\x1b[31mx\x1b[39m');
});

test('narrow: only the newest samples that fit; wide: two columns per sample', () => {
  // mock history tops at 58 → axis 100 (4 cells); 60 cols leave 54 plot columns, 40 cols leave 34
  expect(chart(makeSnapshot({ speed: null }), ui(), 60, 4, G, false)[0]?.endsWith('last 54s')).toBe(true);
  const narrow = chart(makeSnapshot({ speed: null }), ui(), 40, 4, G, false);
  expect(visibleWidth((narrow[3] ?? '').trimEnd())).toBe(40); // the caption's right side is dropped here
  const wide = chart(makeSnapshot({ speed: null }), ui(), 130, 4, G, false);
  expect(visibleWidth((wide[3] ?? '').trimEnd())).toBe(2 + 4 + 120);
});

test('warmup and blocked ping: caption only, plot rows blank', () => {
  const warm = chart(makeSnapshot({ rttHistory: [] }), ui(), 60, 4, G, false);
  expect(warm[0]).toContain('LATENCY  measuring…');
  expect(warm.slice(1).every((l) => l.trim() === '')).toBe(true);
  const blocked = chart(makeSnapshot({ icmpBlocked: true, rttProxyMs: 310 }), ui(), 80, 4, G, false);
  expect(blocked[0]).toContain('LATENCY  310ms via web checks (ping blocked)');
  expect(blocked.slice(1).every((l) => l.trim() === '')).toBe(true);
});

test('all lost: "no replies" and a row of x along the bottom', () => {
  const lines = chart(makeSnapshot({ rttHistory: new Array(10).fill(null), latencyMs: null, latencyP95: null, speed: null }), ui(), 60, 4, G, false);
  expect(lines[0]).toContain('LATENCY  no replies');
  expect(lines[3]?.trimEnd().endsWith('x'.repeat(10))).toBe(true);
});

test('satellite: raw-ms axis, caption says satellite, bars green after the offset', () => {
  const snap = makeSnapshot({ sat: true, rttOffset: 500, rttHistory: [600, 600, 600], latencyMs: 600, latencyP95: 640, speed: null });
  const lines = chart(snap, ui(), 60, 4, G, true);
  expect(strip(lines[0] ?? '')).toContain('· satellite');
  expect(strip(lines[1] ?? '').startsWith('  1000┤')).toBe(true);
  expect(lines[3]).toContain('\x1b[32m');
});

test('extreme RTTs: a 12000 ms spike widens the axis but never the row', () => {
  const snap = makeSnapshot({ rttHistory: [40, 12000, 45], latencyMs: 45, latencyP95: 12000, speed: null });
  const lines = chart(snap, ui(), 40, 6, G, true);
  expect(strip(lines[1] ?? '').startsWith('  20000┤')).toBe(true);
  for (const l of lines) expect(visibleWidth(l)).toBe(40);
});

test('caption right side: speed test result, or running', () => {
  expect(strip(chart(makeSnapshot(), ui(), 80, 4, G, true)[0] ?? '')).toContain('speed test 12m ago:');
  expect(chart(makeSnapshot(), ui({ speedRunning: true }), 80, 4, G, false)[0]?.endsWith('speed test running…')).toBe(true);
});

test('every size: exactly rows lines of exactly cols cells; ascii stays ASCII', () => {
  for (const cols of [40, 60, 80, 100, 130, 160]) {
    for (let rows = 1; rows <= 14; rows++) {
      const lines = chart(makeSnapshot({ rttHistory: [5, null, 900, 40] }), ui(), cols, rows, G, true);
      expect(lines.length).toBe(rows);
      for (const l of lines) expect(visibleWidth(l)).toBe(cols);
    }
  }
  for (const l of chart(makeSnapshot({ speed: null }), ui(), 80, 7, A, false)) expect(ASCII_RE.test(l)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-chart.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/ui/ansi.ts` — in `interface Glyphs` after `link`, add:

```ts
  axis: string; // ┤ chart y axis
  eighths: readonly string[]; // ▁▂▃▄▅▆▇ partial chart cells, 1/8 … 7/8
  full: string; // █ full chart cell
```

and in `GLYPHS`: unicode `axis: '┤', eighths: ['▁', '▂', '▃', '▄', '▅', '▆', '▇'], full: '█',`; ascii `axis: '|', eighths: ['.', '_', '-', '=', '+', '*', '%'], full: '#',`.

`src/ui/sections/common.ts` — append:

```ts
/** One character per cell with a color each → one escape pair per run of equal color. */
export function paintRuns(chars: readonly string[], colors: readonly (ColorName | null)[], on: boolean): string {
  let out = '';
  let run = '';
  let cur: ColorName | null = null;
  chars.forEach((ch, i) => {
    const c = colors[i] ?? null;
    if (c !== cur) {
      out += paint(cur, run, on);
      run = '';
      cur = c;
    }
    run += ch;
  });
  return out + paint(cur, run, on);
}
```

Create `src/ui/sections/chart.ts`:

```ts
// Simple-view latency chart (simple-view spec §4): a caption row, then a linear bar chart of the last
// 60 internet RTT samples, newest at the right, each bar colored by its §7.2 tier band. Pure.
import { GRADE_TIERS } from '../../config';
import { fit, fmtMs, padStart, visibleWidth } from '../../core/format';
import type { Snapshot, UiState } from '../../model/types';
import type { ColorName, Glyphs } from '../ansi';
import { LEAD, paint, paintRuns } from './common';
import { speedText } from './metrics-cells';

const MIN_SAMPLES = 3; // fewer → "measuring…"
const WIDE_PLOT = 120; // plot width at which each sample gets two columns
const GREEN_MAX = GRADE_TIERS[1]?.rtt ?? 300; // tier B
const YELLOW_MAX = GRADE_TIERS[2]?.rtt ?? 800; // tier C

/** Smallest of 50, 100, 200, 500, 1000, 2000, 5000, … that is ≥ max. */
export function niceTop(max: number): number {
  if (!Number.isFinite(max)) return 50;
  for (let e = 1; e < 12; e++) {
    for (const k of [1, 2, 5]) {
      const t = k * 10 ** e;
      if (t >= 50 && t >= max) return t;
    }
  }
  return 10 ** 12;
}

/** Bar height in eighths of a row: at least 1 for any reply, at most rows × 8. */
export function barEighths(v: number, rows: number, top: number): number {
  const total = rows * 8;
  if (!(v > 0) || top <= 0) return 0;
  return Math.max(1, Math.min(total, Math.round((total * v) / top)));
}

/** §7.2 tier band of one sample, satellite offset removed. */
export function barColor(v: number, offset: number): ColorName {
  const r = v - offset;
  return r <= GREEN_MAX ? 'green' : r <= YELLOW_MAX ? 'yellow' : 'red';
}

/** Glyph for plot row `fromBottom` (0 = bottom) of a bar `e` eighths tall. */
function barCell(e: number, fromBottom: number, g: Glyphs): string {
  const fill = Math.max(0, Math.min(8, e - fromBottom * 8));
  if (fill === 0) return ' ';
  return fill === 8 ? g.full : g.eighths[fill - 1] ?? g.full;
}

interface Plot { axisW: number; top: number; per: number; shown: (number | null)[] }

function geometry(snap: Snapshot, cols: number): Plot {
  const nums = snap.rttHistory.filter((v): v is number => v != null && Number.isFinite(v));
  const top = niceTop(nums.length ? Math.max(...nums) : 0);
  const axisW = String(top).length + 1;
  const width = Math.max(0, cols - LEAD.length - axisW);
  const per = width >= WIDE_PLOT ? 2 : 1;
  const n = Math.floor(width / per);
  return { axisW, top, per, shown: n > 0 ? snap.rttHistory.slice(-n) : [] };
}

function axisLabel(r: number, rows: number, p: Plot, g: Glyphs, on: boolean): string {
  const mid = Math.round(rows / 2);
  let label = '';
  if (r === 0) label = String(p.top);
  else if (rows >= 4 && r === mid) label = String(Math.round((p.top * (rows - r)) / rows));
  return paint('dim', padStart(label, p.axisW - 1) + g.axis, on);
}

function plotRows(snap: Snapshot, p: Plot, rows: number, g: Glyphs, on: boolean): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const fromBottom = rows - 1 - r;
    const chars: string[] = [];
    const colors: (ColorName | null)[] = [];
    for (const v of p.shown) {
      const ch = v == null ? (fromBottom === 0 ? g.lost : ' ') : barCell(barEighths(v, rows, p.top), fromBottom, g);
      const c: ColorName = v == null ? 'red' : barColor(v, snap.rttOffset);
      for (let k = 0; k < p.per; k++) {
        chars.push(ch);
        colors.push(ch === ' ' ? null : c);
      }
    }
    out.push(LEAD + axisLabel(r, rows, p, g, on) + paintRuns(chars, colors, on));
  }
  return out;
}

function captionLeft(snap: Snapshot, g: Glyphs): string {
  if (snap.icmpBlocked) {
    return snap.rttProxyMs == null
      ? 'LATENCY  ping blocked'
      : `LATENCY  ${fmtMs(snap.rttProxyMs)}ms via web checks (ping blocked)`;
  }
  if (snap.rttHistory.length < MIN_SAMPLES) return `LATENCY  measuring${g.ellipsis}`;
  if (snap.latencyMs == null) return 'LATENCY  no replies';
  let s = `LATENCY  ${fmtMs(snap.latencyMs)}ms typical`;
  if (snap.latencyP95 != null) s += ` ${g.sep} ${fmtMs(snap.latencyP95)}ms peaks`;
  if (snap.sat) s += ` ${g.sep} satellite`;
  return s;
}

function captionRight(snap: Snapshot, ui: UiState, shown: number, g: Glyphs): string {
  if (ui.speedRunning) return `speed test running${g.ellipsis}`;
  if (snap.speed) return `speed ${speedText(snap, g)}`;
  return shown > 0 ? `last ${shown}s` : '';
}

/** Caption row: left text, right text right-aligned (dropped when it does not fit). */
function caption(left: string, right: string, w: number, on: boolean): string {
  const gap = w - visibleWidth(left) - visibleWidth(right);
  if (!right || gap < 2) return fit(left, w);
  return fit(left + ' '.repeat(gap) + paint('dim', right, on), w);
}

/** `rows` lines (caption + plot rows), exactly `cols` cells each. */
export function chart(snap: Snapshot, ui: UiState, cols: number, rows: number, g: Glyphs, on: boolean): string[] {
  if (rows <= 0) return [];
  const p = geometry(snap, cols);
  const plotting = !snap.icmpBlocked && snap.rttHistory.length >= MIN_SAMPLES;
  const right = captionRight(snap, ui, plotting ? p.shown.length : 0, g);
  const lines = [caption(LEAD + captionLeft(snap, g), right, cols, on)];
  if (plotting) lines.push(...plotRows(snap, p, rows - 1, g, on));
  while (lines.length < rows) lines.push('');
  return lines.map((l) => fit(l, cols));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean. If the `plot:` test's expected rows differ, recheck `barEighths` rounding against the arithmetic in the test (200 top, 4 plot rows: 100 → 16 eighths = 2 full rows; 50 → 8 = 1 row) before changing the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ansi.ts src/ui/sections/common.ts src/ui/sections/chart.ts tests/simple-chart.test.ts
git commit -m "feat(ui): simple-view latency chart" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 8: Drop summary line

**Files:**
- Create: `src/ui/sections/drop-summary.ts`
- Test: `tests/simple-drops.test.ts` (new)

**Interfaces:**
- Consumes: `shedRight`, `paint`, `LEAD` (common.ts).
- Produces: `dropSegments(snap: Snapshot, on: boolean): string[]`; `dropSummary(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[]` (1 row).

- [ ] **Step 1: Write the failing test** — create `tests/simple-drops.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { dropSummary } from '../src/ui/sections/drop-summary';
import { glyphs } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { makeDrops, makeOutage, makeSnapshot, NO_DROPS } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const row = (o: Parameters<typeof makeSnapshot>[0], w = 100, g = G, on = false): string =>
  (dropSummary(makeSnapshot(o), w, g, on)[0] ?? '').trimEnd();

test('recent drops: count, typical length, longest, since last', () => {
  expect(row({})).toBe('  3 drops · usually ~22s · longest 1m04s · last 4m ago');
  expect(row({ drops: makeDrops({ drops15: 1 }) })).toBe('  1 drop · usually ~22s · longest 1m04s · last 4m ago');
});

test('no drops in the session / only earlier drops', () => {
  expect(row({ drops: NO_DROPS })).toBe('  no drops');
  expect(dropSummary(makeSnapshot({ drops: NO_DROPS }), 80, G, true)[0]).toContain('\x1b[32mno drops\x1b[39m');
  expect(row({ drops: makeDrops({ drops15: 0, sinceLastDrop: 2520 }) })).toBe('  no drops in 15m · last 42m ago');
});

test('during an outage: how long drops usually last here', () => {
  const open = makeOutage({ endedAt: null });
  expect(row({ openOutage: open })).toBe('  drops here usually last ~22s · longest 1m04s');
  expect(row({ openOutage: open, drops: NO_DROPS })).toBe('');
});

test('sheds whole segments at narrow widths; ascii separator', () => {
  expect(row({}, 40)).toBe('  3 drops · usually ~22s · longest 1m04s');
  expect(visibleWidth(dropSummary(makeSnapshot(), 40, G, false)[0] ?? '')).toBe(40);
  expect(row({}, 100, A)).toBe('  3 drops | usually ~22s | longest 1m04s | last 4m ago');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-drops.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/ui/sections/drop-summary.ts`:

```ts
// Simple-view drop summary under the timeline (simple-view spec §4):
// `3 drops · usually ~22s · longest 1m04s · last 4m ago`, segments shed from the right. Pure.
import { fit, fmtAgo, fmtDuration } from '../../core/format';
import type { Snapshot } from '../../model/types';
import type { Glyphs } from '../ansi';
import { LEAD, paint, shedRight } from './common';

/** The summary's segments for this snapshot (empty during an outage with no history). */
export function dropSegments(snap: Snapshot, on: boolean): string[] {
  const d = snap.drops;
  const usually = d.dropMedianS == null ? null : `usually ~${fmtDuration(d.dropMedianS)}`;
  const longest = d.dropLongestS == null ? null : `longest ${fmtDuration(d.dropLongestS)}`;
  const last = d.sinceLastDrop == null ? null : `last ${fmtAgo(d.sinceLastDrop)}`;
  let segs: (string | null)[];
  if (snap.openOutage) {
    segs = d.dropMedianS == null ? [] : [`drops here usually last ~${fmtDuration(d.dropMedianS)}`, longest];
  } else if (d.dropsSession === 0) {
    segs = [paint('green', 'no drops', on)];
  } else if (d.drops15 === 0) {
    segs = [paint('green', 'no drops in 15m', on), last];
  } else {
    segs = [`${d.drops15} drop${d.drops15 === 1 ? '' : 's'}`, usually, longest, last];
  }
  return segs.filter((s): s is string => s !== null);
}

/** One row, exactly `w` cells (blank when there is nothing to say). */
export function dropSummary(snap: Snapshot, w: number, g: Glyphs, on: boolean): string[] {
  const segs = dropSegments(snap, on);
  return [fit(segs.length ? LEAD + shedRight(segs, ` ${g.sep} `, w - LEAD.length) : '', w)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sections/drop-summary.ts tests/simple-drops.test.ts
git commit -m "feat(ui): simple-view drop summary" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 9: View-dependent footer keys

**Files:**
- Modify: `src/ui/sections/footer.ts` (key parts by view, label levels, shedding order)
- Modify: `tests/sections-b.test.ts` (footer test assertions, in place), `tests/sections-b2.test.ts` (footer shedding assertions)
- Test: `tests/simple-footer.test.ts` (new)

**Interfaces:**
- Consumes: `UiState.view` (Task 1).
- Produces: `footer(snap, ui, w)` unchanged signature; simple keys `[o login] v details · t speed test · b bell · q quit`, advanced keys gain `v simple`.

Shedding rules after this task (update the doc comment on `footer()` to match): key labels squeeze through three levels — `hint` (`t speed test (250 KB)`, advanced only), `plain` (`t speed test`), `short` (`t speed`, `o portal`). With a transient message, the right side (probe rate) is shed before the labels are squeezed; without one, labels are squeezed before the right side is shed. The log status is never shed (§10). A message that does not fit beside the shortest keys is cut; if fewer than 12 cells are left for it, it is shown alone (keys hidden until it expires) rather than dropped. The simple view has no probe rate on the right.

- [ ] **Step 1: Write the failing test** — create `tests/simple-footer.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { footer } from '../src/ui/sections/footer';
import { visibleWidth } from '../src/core/format';
import type { UiState } from '../src/model/types';
import { makeSnapshot } from './helpers/snapshot';

const ui = (o: Partial<UiState> = {}): UiState => ({
  view: 'simple', bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null, ...o,
});
const f = (w: number, o: Partial<UiState> = {}, snap = makeSnapshot()): string => footer(snap, ui(o), w)[0] ?? '';

test('simple footer: v details first, no probe rate', () => {
  expect(f(80).trimEnd()).toBe('  v details  t speed test  b bell:on  q quit');
  expect(f(100).trimEnd()).toBe('  v details   t speed test   b bell:on   q quit');
  expect(f(80)).not.toContain('probes');
  expect(visibleWidth(f(80))).toBe(80);
});

test('simple footer: o login only while PORTAL', () => {
  expect(f(80, {}, makeSnapshot({ state: 'PORTAL' })).startsWith('  o login  v details')).toBe(true);
  expect(f(80)).not.toContain('o login');
});

test('simple footer at 40 cols: short labels, every key whole', () => {
  expect(f(40).trimEnd()).toBe('  v details  t speed  b bell:on  q quit');
});

test('simple footer keeps the log status and cuts a long message, keys whole', () => {
  expect(f(60, { logStatus: 'on' }).endsWith('log: on')).toBe(true);
  // 40 cols: no room beside the keys, so the message shows alone (never silently dropped)
  const m = f(40, { footerMsg: 'speed test: 22 Mbps down', footerMsgUntil: null });
  expect(visibleWidth(m)).toBe(40);
  expect(m.trimEnd()).toBe('  speed test: 22 Mbps down');
  const r = f(60, { footerMsg: 'speed test: 22 Mbps down', footerMsgUntil: null });
  expect([r.includes('q quit'), r.includes('speed test: 22'), visibleWidth(r)]).toEqual([true, true, 60]);
});

test('advanced footer gains v simple and keeps it at 72 cols', () => {
  const a = footer(makeSnapshot(), ui({ view: 'advanced' }), 72)[0] ?? '';
  expect(a.startsWith('  q quit  t speed  b bell:on  o portal  v simple')).toBe(true);
  expect(a.endsWith('probes ~1.2 MB/h')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/simple-footer.test.ts`
Expected: FAIL (simple keys not rendered).

- [ ] **Step 3: Implement** — in `src/ui/sections/footer.ts`:

Change the model import to `import type { Snapshot, UiState, View } from '../../model/types';`, then replace `keyParts`, `keysRow`, `cutMsg`'s caller and `halves` with:

```ts
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

/** Keys (+ the transient message when one is given), joined by the layout gap. */
function keysRow(snap: Snapshot, ui: UiState, gap: string, level: KeyLevel, msg: string | null): string {
  return LEAD + [...keyParts(snap, ui, level), ...(msg ? [msg] : [])].join(gap);
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
```

In `footer()`, replace the `probes` / `log` / `rights` lines and the `halves` call with:

```ts
  const probes = ui.view === 'simple' ? null : `probes ~${fmtBytes(snap.probeRateEst)}/h`; // §4.10
  const log = ui.logStatus ? `log: ${ui.logStatus}` : null;
  let rights: string[];
  if (log) rights = probes ? [`${log}  ${probes}`, log] : [log];
  else if (probes) rights = msg ? [probes, ''] : [probes];
  else rights = [''];
  const [row, right] = halves(snap, ui, gap, msg, rights, w);
```

Update the `footer()` doc comment to the shedding rules stated above this task's steps.

Existing tests (advanced view) — change these assertions in place, nothing else:

`tests/sections-b.test.ts`, test `footer: keys left, probe rate right-aligned to width; live states`:
- `c[0]?.startsWith('  q quit  t speed test (250 KB)  b bell:off  o open portal')` → `c[0]?.startsWith('  q quit  t speed test  b bell:off  o open portal  v simple')`
- `msg.includes('o open portal   not while down')` → `msg.includes('v simple   not while down')`
- `n.startsWith('  q quit  t speed test  b bell:on  o open portal')` → `n.startsWith('  q quit  t speed  b bell:on  o portal  v simple')`
- `nl.includes('o open portal')` → `nl.includes('o portal')`

`tests/sections-b2.test.ts`, test `footer sheds the probe rate before the transient message`:
- `expect(f80).toContain('o open portal');` → `expect(f80).toContain('o portal');`
- `long.includes('o open portal')` → `long.includes('o portal')`
- Replace the comment + line `// no message: the probe rate stays, the size hint is what goes first (§8.2 mockup)` / `expect(footer(makeSnapshot(), ui(), 80)[0]).toContain('t speed test (250 KB)');` with `// no message: the probe rate stays; the size hint is what goes first` / `expect(footer(makeSnapshot(), ui(), 80)[0]).toContain('  t speed test  ');`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean. If an existing footer assertion still fails, compute the row by hand from the rules above (gap is 3 spaces at ≥ 100 cols, else 2) before touching it, and change only that expectation.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sections/footer.ts tests/simple-footer.test.ts tests/sections-b.test.ts tests/sections-b2.test.ts
git commit -m "feat(ui): view-dependent footer keys (v details / v simple)" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 10: Render wiring, render-once and the live pty check

**Files:**
- Modify: `src/app/render.ts` (branch on `ui.view`)
- Modify: `scripts/render-once.ts` (both views, five sizes, `--view`)
- Modify: `scripts/tui-session.exp` (press `v`)
- Modify: `tests/tui-pty.test.ts` (new e2e test)
- Test: `tests/render-views.test.ts` (new)

**Interfaces:**
- Consumes: everything above — `planSimpleLayout`, `simpleHeader`, `status`, `chips`, `chain`, `chart`, `dropSummary`, `timeline`, `tip`, `footer`.
- Produces: `frameLines(snap, ui, size, g, colorOn)` draws `ui.view`.

- [ ] **Step 1: Write the failing test** — create `tests/render-views.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { frameLines } from '../src/app/render';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import type { UiState, View } from '../src/model/types';
import { makeSnapshot, makeVerdicts } from './helpers/snapshot';

const ASCII_RE = /^[\x00-\x7f]*$/;
// the fixture's video reason has a literal '·'; real verdicts use g.sep, which is '|' in --ascii
const asciiSnap = () => makeSnapshot({ verdicts: makeVerdicts({ 'VIDEO CALL': { reason: 'jitter 71ms | audio ok' } }) });
const ui = (view: View): UiState => ({
  view, bellOn: true, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
  lastSpeed: null, speedRunning: false, logStatus: null,
});
const SIZES = [{ cols: 40, rows: 10 }, { cols: 60, rows: 15 }, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 160, rows: 50 }];

test('every view x size x glyph set: exactly rows lines, none wider than cols', () => {
  for (const view of ['simple', 'advanced'] as View[]) {
    for (const size of SIZES) {
      for (const ascii of [false, true]) {
        for (const colorOn of [false, true]) {
          const lines = frameLines(ascii ? asciiSnap() : makeSnapshot(), ui(view), size, glyphs(ascii), colorOn);
          expect(lines.length).toBe(size.rows);
          for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(size.cols);
          if (ascii && !colorOn) for (const l of lines) expect(ASCII_RE.test(l)).toBe(true);
        }
      }
    }
  }
});

test('simple 80x24 matches the spec layout', () => {
  const lines = frameLines(makeSnapshot(), ui('simple'), { cols: 80, rows: 24 }, glyphs(false), false).map(strip);
  expect(lines[0]?.startsWith(' netmon  Wi-Fi (en1)')).toBe(true);
  expect(lines[1]).toBe('');
  expect(lines[2]?.startsWith('  ● UP   OK (B)')).toBe(true);
  expect(lines[5]?.indexOf('✔ Chat')).toBe(2);
  expect(lines[8]?.startsWith('  Wi-Fi ✔────')).toBe(true);
  expect(lines[10]?.startsWith('  LATENCY  48ms typical')).toBe(true);
  expect(lines[18]?.startsWith(' LAST 15m ')).toBe(true);
  expect(lines[20]?.startsWith('  3 drops · usually ~22s')).toBe(true);
  expect(lines[23]?.startsWith('  v details')).toBe(true);
});

test('advanced view is today\'s screen plus v simple', () => {
  const lines = frameLines(makeSnapshot(), ui('advanced'), { cols: 100, rows: 30 }, glyphs(false), false).map(strip);
  expect(lines[0]).toContain('gw 192.168.0.1');
  expect(lines[29]).toContain('v simple');
});

test('too small: each view shows its own message', () => {
  expect(frameLines(makeSnapshot(), ui('simple'), { cols: 39, rows: 10 }, glyphs(false), false)[0]).toBe('too small (need 40x10)');
  expect(frameLines(makeSnapshot(), ui('advanced'), { cols: 60, rows: 15 }, glyphs(false), false)[0])
    .toBe('details need 72x18 (have 60x15); press v');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/render-views.test.ts`
Expected: FAIL (simple view not wired: line 1 is the advanced header).

- [ ] **Step 3: Implement** — rewrite `src/app/render.ts` to:

```ts
// §8 TUI frame: sections → layout → one escape string. `frameLines` is pure (used by
// scripts/render-once.ts) and draws `ui.view` (simple-view spec §2); `drawTui` writes through the Tty.
import type { Snapshot, UiState } from '../model/types';
import type { Glyphs } from '../ui/ansi';
import { composeLines, renderFrame, ruleLine } from '../ui/frame';
import { planLayout, type Size } from '../ui/layout';
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
    chart: chart(snap, ui, w, plan.chartRows, g, colorOn),
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
```

Rewrite `scripts/render-once.ts` to:

```ts
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
```

`scripts/tui-session.exp` — insert before `send "q"`:

```
send "v"
set timeout 6
expect { timeout {} }
```

`tests/tui-pty.test.ts` — append this test (same file conventions; reuse `EXPECT`, `ROOT`, `hasExpect`):

```ts
test.skipIf(!hasExpect)('v switches from the simple view to the advanced view live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmon-pty-'));
  const script = join(dir, 'view.exp');
  writeFileSync(script, [
    'spawn -noecho bun run src/main.ts --no-bell',
    'stty rows 30 columns 100 < $spawn_out(slave,name)',
    'set timeout 3',
    'expect { timeout {} }',
    'send "v"',
    'set timeout 3',
    'expect { timeout {} }',
    'send "q"',
    'set timeout 15',
    'expect eof',
    '',
  ].join('\n'));
  const proc = Bun.spawn([EXPECT, script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const firstAdvanced = out.indexOf('v simple');
  expect(out.indexOf('v details')).toBeGreaterThanOrEqual(0); // starts in the simple view
  expect(firstAdvanced).toBeGreaterThan(out.indexOf('v details')); // ...then the advanced footer
  expect(out).toContain('\x1b[?1049l'); // left the alt screen on q
}, 30_000);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Check by eye**

Run: `bun run scripts/render-once.ts --view simple` and compare the 80×24, 60×15 and 40×10 frames with the spec §3.1 mockups (chart bars differ: the mock history is a sawtooth). Then `expect scripts/tui-session.exp > "$TMPDIR/out.txt"; bun run scripts/pty-frame.ts "$TMPDIR/out.txt"` — the last frame must be the advanced view. (Use the session scratchpad instead of `$TMPDIR` if one is available.)

- [ ] **Step 6: Commit**

```bash
git add src/app/render.ts scripts/render-once.ts scripts/tui-session.exp tests/render-views.test.ts tests/tui-pty.test.ts
git commit -m "feat(ui): draw the simple view by default; v toggles live" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-network-monitor-design.md` (§2, §8.4, new §8.8, §12)
- Modify: `README.md` (Keys table, flags list, a "Simple and advanced views" paragraph)
- Modify: `CLAUDE.md` ("Driving the real UI": render-once `--view`)

- [ ] **Step 1: Main spec**
- §2: after the numbered list add: `The default **simple view** answers 1–4 with a state badge, activity chips, a hop chain, a latency chart and the timeline; the dense screen in §8.1/§8.2 is the **advanced view** (key \`v\`, flag \`--advanced\`). See \`2026-10-02-simple-view-design.md\`.`
- §8.4 table: add the row ``| `v` | switch between the simple view (default) and the advanced view (§8.8) |``.
- Add `### 8.8 Simple view` after §8.7: `The default TUI screen. Layout, sections, colors, glyphs and edge cases are specified in \`docs/superpowers/specs/2026-10-02-simple-view-design.md\`. Minimum 40×10; \`v\` toggles to the advanced view (§8.1/§8.2, minimum 72×18), whose too-small message points back at \`v\`.`
- §12 usage block: add `  --advanced           start in the detailed view (default: the simple view)` after `--plain`.

- [ ] **Step 2: README**
- Flags block: add the same `--advanced` line after `--plain`.
- Keys table: add ``| `v` | switch between the simple view and the advanced (detailed) view |``.
- Under `## Reading the screen`, before `### State & grade`, add a short paragraph: `netmon opens in the **simple view**: a colored state badge, the four activity verdicts as colored chips, the hop path as a chain of colored dots, a latency chart for the last minute (bars green/yellow/red by quality, \`x\` = lost), and the 15-minute timeline with a one-line drop summary. Press \`v\` (or start with \`--advanced\`) for the **advanced view** described below, with every number.`

- [ ] **Step 3: CLAUDE.md** — in "Driving the real UI", change the mock-frames bullet to: `` Mock frames: `bun run scripts/render-once.ts [--view simple|advanced|both]` renders the mock Snapshot in each view (simple at 40×10 … 160×50, advanced at 100×30 and 80×24) with escapes stripped. The TUI starts in the simple view; `v` toggles. ``

- [ ] **Step 4: Verify** — `bun test && bunx tsc --noEmit` (all PASS).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-06-network-monitor-design.md README.md CLAUDE.md
git commit -m "docs: simple and advanced views, v key and --advanced flag" -m "Claude-Session: https://claude.ai/code/session_016Vqfr1BTTjVRHqy5b3w2ub"
```
