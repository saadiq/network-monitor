# netmon — simple view (default) + advanced view: design spec

Date: 2026-10-02. Extends `2026-09-06-network-monitor-design.md` (the "main spec"); section numbers
below that start with `§` refer to the main spec unless marked otherwise.

## 1. Goal

Today's screen gives every row the same visual weight, so nothing reads as *the answer* and the
data is overwhelming. Add a **simple view** that answers the three glance questions with shape and
color rather than numbers, and keep today's dense screen as the **advanced view**:

1. **Is it working?** — a big colored state badge and one plain sentence.
2. **What can I do?** — four colored activity chips and a colored hop chain.
3. **How has it been?** — a tall latency chart and the 15-minute timeline with a one-line drop summary.

It must read well both in a small side pane (down to 40×10) and in a full terminal window, where the
chart takes the extra rows.

Non-goals: no new probes, metrics or Snapshot fields; no change to plain mode (§8.5), the JSONL log
(§11), the quit report (§8.6) or alerts (§8.7); no persisted preference; no runtime dependencies;
256-color/truecolor palettes (the 8 ANSI colors are kept so the user's terminal theme applies).

## 2. Modes and switching

- `UiState.view: 'simple' | 'advanced'`, initialised from the CLI: `'simple'` by default,
  `'advanced'` with the new `--advanced` flag (§12, listed in `--help`).
- Key `v` toggles the view and repaints immediately (same path as other key repaints, §8.3 fps cap).
- The advanced view is today's screen, unchanged except that its footer gains `v simple` (it sheds
  through the existing footer ladder: size hint first, §8.4).
- `--plain` ignores the view entirely.

## 3. Simple layout

`planSimpleLayout(size)` is pure (size in, placement out), like `planLayout` (§8.2).

| Section | Rows | Content |
|---|---|---|
| `header` | 1 | ` netmon  Wi-Fi (en1)` (+ ` · vpn`), clock right-aligned |
| `status` | 2 | state badge + grade + timer + trend; banner sentence (`snap.banner[1]`) |
| `chips` | 2 | four activity chips; dim reason under each non-OK chip |
| `chain` | 1 | hop chain `Wi-Fi ●──── Router ●──── Internet ●──── DNS ●──── Web ●` |
| `chart` | 4–14 | caption row + latency plot rows (absorbs leftover rows) |
| `timeline` | 3 | bar, marker row (both as §8.1), drop summary line |
| `tip` | 1 | `TIP  …` (blank row when there is no tip) |
| `footer` | 1 | keys, pinned to the last row |

Placement, while rows remain (each step only if its rows fit):

1. In priority order: `header`, `status`, `chips`, `footer`, `timeline`, `chain`, `chart` (at its
   minimum, 4), `tip`.
2. Then one blank **spacer** row below each placed section, top to bottom, in this order: header,
   status, chips, chain, chart, timeline.
3. Then every remaining row goes to `chart`, up to 14 rows.
4. Anything still left stays blank above the footer.

Display order is the table order. Below **40×10** the frame is only `too small (need 40x10)`.

Resulting allocations: 40×10 → no chart, no tip, no spacers; 60×15 → chart 4, no spacers;
80×24 → chart 7, all six spacers; 100×30 → chart 13; 160×50 → chart 14, rest blank.

The advanced view keeps 72×18 as its minimum; below that it shows
`need 72x18 for details (have CxR) · v: simple view`.

### 3.1 Mockups (colors described in §5)

80×24:

```
 netmon  Wi-Fi (en1)                                                    14:32:07

   UP    OK (B)   steady 4m12s   getting worse ▲
  Fine for chat & browsing. Video call shaky (jitter 71ms). Big downloads: no…

  ✔ Chat             ✔ Browse           ~ Video call       ✘ Download
                                        jitter 71ms        3 drops/15m

  Wi-Fi ●──── Router ●──── Internet ●──── DNS ●──── Web ●

  LATENCY  48ms typical · 86ms peaks                                  last 60s
  200┤                                              ▆
     ┤                    ▃                        ██
     ┤                   ██            ▂           ██
  100┤      ▅           ███▄          ██          ███
     ┤▂▃▄▂▁▂█▃▁▂▃▂▁▁▂▃▄▅████▂▁▁▂▃▂▃▄▅▃▂██▁▂▃▄▂▁▂▃▄▅▅███▂▁
     ┤███████████████████████████████████████x█████████

 LAST 15m ████████░░██████████████▒▒▒▒██████████████████░░░███████████████████████
          -15m   ▲14:19 wifi   ▲14:21 portal          ▲14:27 uplink             now
  3 drops · usually ~22s · longest 1m04s · last 4m12s ago

  TIP  Tailscale DNS is 12x slower than direct (380 vs 31ms) — consider pausing it.
  v details   t speed test   b bell:on   q quit
```

60×15:

```
 netmon  Wi-Fi (en1)                                14:32:07
   UP    OK (B)   steady 4m12s   getting worse ▲
  Fine for chat & browsing. Video call shaky (jitter 71ms)…
  ✔ Chat        ✔ Browse      ~ Video call  ✘ Download
                              jitter 71ms   3 drops/15m
  Wi-Fi ●──── Router ●──── Internet ●──── DNS ●──── Web ●
  LATENCY  48ms typical · 86ms peaks                last 54s
  200┤                    ▃            ▂           ▆
     ┤      ▅           ███▄          ██          ███
     ┤▂▃▄▂▁▂█▃▁▂▃▂▁▁▂▃▄▅████▂▁▁▂▃▂▃▄▅▃▂██▁▂▃▄▂▁▂▃▄▅▅█
 LAST 15m ██████░░████████▒▒▒▒██████████████░░░████████████
          -15m ▲14:19  ▲14:21 portal  ▲14:27 uplink      now
  3 drops · usually ~22s · longest 1m04s · last 4m12s ago
  TIP  Tailscale DNS is 12x slower than direct (380 vs 31ms…
  v details   t speed test   b bell:on   q quit
```

40×10:

```
 netmon  Wi-Fi (en1)            14:32:07
   UP    OK (B)   steady 4m12s
  Fine for chat & browsing. Video call…
  ✔ Chat            ✔ Browse
  ~ Video call      ✘ Download
  Wi-Fi ●─Router ●─Inet ●─DNS ●─Web ●
 LAST 15m ██████░░████████▒▒▒▒██████████
          -15m ▲   ▲portal  ▲uplink  now
  3 drops · usually ~22s · longest 1m04s
  v details  t speed  b bell:on  q quit
```

## 4. Sections

Every section returns exactly its rows, each fitted to `cols` (ANSI-aware), like the §8.1 sections.

**header** — ` netmon` (bold) + two spaces + the link: `Wi-Fi (<iface>)` when `wifiStatus !== 'off'`,
else `<iface>`; ` · vpn` when `snap.vpn`. The clock (`fmtTime(snap.wall)`) is right-aligned. No
gateway, DNS, probe bytes or run time (those stay in the advanced header).

**status** — row 1 segments, separated by 3 spaces, shed whole from the right until the row fits:
badge (always kept), grade word `OK (B)` (or the cause label for non-graded states, as
`banner.ts`'s `causeLabel`), timer (`steady 4m12s` in UP/DEGRADED, the red/magenta `DOWN 0:42`
clock while offline), trend phrase + arrow, `FLAKY`, `sat +Nms`, `~ under load`. The drops count is
not repeated here (it is in the timeline summary). Row 2 is `snap.banner[1]`, cut with `…`. The
2-tick inverse flash after a transition (§8.1) applies to both rows, as today.

**chips** — four equal columns of `floor((cols − 2) / 4)` cells. Row 1 per column:
`<mark glyph> <name>` in the verdict color (`✔` OK green, `~` SHAKY yellow, `✘` NO red). Names are
`Chat`, `Browse`, `Video call`, `Download`. Row 2: the verdict `reason` (dim) under each non-OK chip,
cut at the last ` · ` that fits the column width − 1, else truncated with `…`. Below 46 cols the
chips form a 2×2 grid (two columns per row, both rows used) and reasons are not shown.

**chain** — built from the same hop list as the §8.1 PATH row (hops hidden there are hidden here:
no Wi-Fi hop when not the egress, no Router without a pingable gateway). Each hop renders as
`<name> <dot>`, joined by dim connectors. The dot is `●` colored by the hop's mark (green ok, yellow
shaky, red fail, magenta portal, dim `–`/`?`); with color off the dot is the hop's mark glyph instead
(`✔ ~ ✘ – ?`) so status survives `--no-color`. The first non-ok hop also shows its short detail after
the dot, in its color (`Internet ● no reply 42s`). Width ladder until the row fits: connector `──── ` →
`─── ` → `── ` → `─ ` → `─`, then the hop detail is dropped, then `Internet` → `Inet`.

**chart** — row 1 is the caption: `LATENCY  48ms typical · 86ms peaks` (`latencyMs` and `latencyP95`;
the peaks part is omitted when null; ` · satellite` appended when `snap.sat`). Right-aligned on the
caption row: `speed test ↓2.8 MB/s 12m ago` when `snap.speed` exists (`speed test running…` while
`ui.speedRunning`), else `last <n>s`, where n is the number of samples shown. Below that are the plot
rows (chart rows − 1, at least 3):

- Source: `snap.rttHistory` (≤ 60 samples, oldest → newest, `null` = lost).
- Y axis: a label column `<top>┤` on the first plot row, `<half>┤` on the middle row (at ≥ 4 plot rows),
  `┤` elsewhere, right-aligned to the width of the top label.
- Scale: linear from 0 to the smallest value of the series 50, 100, 200, 500, 1000, 2000, 5000, …
  that is ≥ the largest sample (so the top is never below 50 ms).
- Plot width = cols − 2 − axis width. One column per sample, two per sample when the width is
  ≥ 120. When there are more samples than columns, the newest are shown. The newest sample sits at
  the right edge of the plotted run, and the run starts right after the axis.
- Bars: height in eighths of a row (`rows × 8 × v / top`), full rows `█`, partial top cell from the
  eighth-block ramp `▁▂▃▄▅▆▇`.
- Bar color per sample, using `v − snap.rttOffset` against the §7.2 tier RTT limits: ≤ tier B
  (300 ms) green, ≤ tier C (800 ms) yellow, above red. Lost samples draw a red `x` on the bottom row.

**timeline** — rows 1–2 are the existing `timeline()` (§8.1), given
`timelineCells = min(90, cols − 10)` and `cellMs = round(900000 / timelineCells)`, so the bar always
spans 15 minutes and fills the row. Row 3 is the drop summary, segments shed from the right:

| Case | Summary |
|---|---|
| no drops this session | `no drops` (green) |
| `drops15 = 0`, earlier drops | `no drops in 15m · last 42m ago` (green first segment) |
| `drops15 > 0` | `3 drops · usually ~22s · longest 1m04s · last 4m12s ago` |
| open outage | `drops here usually last ~22s · longest 1m04s` (omitted when no closed drops) |

`usually` is `dropMedianS`, `longest` is `dropLongestS`, `last … ago` is `sinceLastDrop`, all from
`snap.drops`.

**tip** — the existing `tip()` row.

**footer** — the existing footer, with keys chosen by view:
- Simple: `v details`, `t speed test` (`(running)` while running), `b bell:on|off`, `q quit`, and
  `o login` first while `state === 'PORTAL'`. The probe rate is not shown on the right; the log
  status and transient messages still are.
- Advanced: today's keys plus `v simple`.

## 5. Color

Only the existing SGR set (§8.1: green, yellow, red, magenta, dim, bold, inverse). Labels and
numbers are dim or default, so that only the status marks carry color:

- Badge: ` UP ` in inverse + the state color (UP green, DEGRADED yellow, DOWN/NO LINK red, PORTAL
  magenta, WARMUP dim), i.e. a colored block. With color off it falls back to `● UP`.
- Grade word in the grade color, trend in yellow (worse) or green (better), as in `banner.ts` today.
- Chips, chain dots and chart bars are colored per §4. Timeline colors are as in §8.1.
- Chart axis, captions, reasons and connectors are dim.

## 6. Glyphs (`--ascii`, `--no-color`)

New `Glyphs` entries: `dot` (`●` / `o`), `link` (`─` / `-`), `axis` (`┤` / `|`), `eighths`
(`▁▂▃▄▅▆▇` / `._-=+*%`), `full` (`█` / `#`). The `x` for lost samples is
the same in both. With color off the chain uses mark glyphs instead of dots (§4), so that no status
is carried by color alone. Chips already show mark glyphs.

## 7. Edge cases

- **WARMUP / fewer than 3 samples:** the plot rows are blank, the caption reads `LATENCY  measuring…`
  (dim), and the chips and chain show the existing unknown marks.
- **ICMP blocked (§6.1):** there is no ping history worth plotting. The caption reads
  `LATENCY  310ms via web checks (ping blocked)` (from `rttProxyMs`) and the plot rows are blank.
- **DOWN:** lost samples draw a red `x` along the bottom row, and the status badge shows the
  outage clock.
- **Satellite (§7.1):** the axis shows raw ms, the bar color subtracts `rttOffset` (§4), and the
  caption says `satellite`.
- **No Wi-Fi hop / no Router hop:** the chain omits them, as PATH does.
- **Footer message longer than the row:** uses the existing cut rules (§8.4).

## 8. Modules

New (pure, each < 300 lines, with unit tests):

- `src/ui/layout-simple.ts`: `planSimpleLayout(size): LayoutPlan`, using the §3 rules.
- `src/ui/sections/hops.ts`: the `Hop` type and the hop builders, moved out of `path.ts` so that
  `path.ts` and `chain.ts` share them. Behaviour is unchanged; the existing path tests must still
  pass.
- `src/ui/sections/status.ts`: badge + status row + sentence.
- `src/ui/sections/chips.ts`: activity chips.
- `src/ui/sections/chain.ts`: hop chain.
- `src/ui/sections/chart.ts`: `chart(snap, ui, cols, rows, g, colorOn)`, plus the exported pure
  helpers `niceTop(max)` and `bars(values, rows, top)`.
- `src/ui/sections/drop-summary.ts`: the timeline summary line.

Changed:

- `layout.ts`: widen `SectionId` with `status | chips | chain | chart`. `tooSmallMessage` takes the
  minimum size and a hint so both views can use it. `LayoutPlan` gains `chartRows`.
- `frame.ts`: `composeLines` is unchanged. The simple view passes `''` as the rule glyph, so the
  plan's rule rows become blank spacers.
- `app/render.ts`: `frameLines` branches on `ui.view` (simple parts / advanced parts). Each branch
  gets its own small function.
- `ansi.ts`: the new glyph entries.
- `footer.ts`: view-dependent key parts.
- `keys.ts`: `KEY_VIEW = 'v'` and `KeyActions.view()`. `app/actions.ts` toggles `ui.view` and
  requests a repaint.
- `cli/args.ts` + `cli/types.ts`: the `--advanced` flag. `main.ts` seeds `UiState.view`.
- `config.ts`: `SIMPLE_MIN_COLS = 40`, `SIMPLE_MIN_ROWS = 10`, `CHART_MIN_ROWS = 4`,
  `CHART_MAX_ROWS = 14`, `CHIPS_GRID_COLS = 46`.
- `scripts/render-once.ts`: renders both views at 40×10, 60×15, 80×24, 100×30 and 160×50
  (`--view simple|advanced|both`, default both).
- Main spec: a new §8.8 "Simple view" pointing to this document; §8.4 gains the `v` key; §12 gains
  `--advanced`; §2 notes that the simple view is the default answer surface.

## 9. Testing

- `layout-simple`: allocations at 40×10, 60×15, 80×24, 100×30 and 160×50 match §3; below 40×10
  only the message is shown; no overlaps; the footer is on the last row; the chart never exceeds 14
  rows.
- `chart`: `niceTop` boundaries (0, 49, 50, 51, 999, 1000, 1001); bar eighths at known values; lost
  samples give `x` on the bottom row; color band edges at 300/800 with and without `rttOffset`;
  newest-at-right truncation at narrow widths; double columns at ≥ 120; WARMUP and ICMP-blocked
  captions.
- `chips`: names, colors and reason cuts at 100/60/46/45/40 cols (the 2×2 grid below 46).
- `chain`: hidden hops, dot colors, first-failure detail, every rung of the width ladder, mark
  glyphs with color off.
- `status` and `drop-summary`: segment shedding and each summary case in §4.
- `footer`: simple keys, `o login` only in PORTAL, `v simple` in advanced at 80 and 100 cols.
- `keys` / `args`: `v` dispatch, `--advanced` parsing and `--help`.
- `render`: for every view × size in `render-once`, exactly `rows` lines, each at most `cols` visible
  cells, in unicode and in `--ascii`.
- Live check: `scripts/tui-session.exp` gains a `v` press (and a press back). The last frame of
  each view is checked with `scripts/pty-frame.ts`. Never press `o`.
