// Pure formatting helpers (§8). Numbers in, strings out; callers handle nulls.
// Bytes/rates are SI (1 KB = 1000 B) to match Mbps arithmetic elsewhere.

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `9s` · `4m12s` · `1h02m` */
export function fmtDuration(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}h${pad2(m)}m`;
  if (m > 0) return `${m}m${pad2(sec)}s`;
  return `${sec}s`;
}

/** Ticking clock: `0:42` · `1:05` · `1:02:07` */
export function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}

/** `28s ago` · `12m ago` · `1h02m ago` */
export function fmtAgo(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t}s ago`;
  if (t < 3600) return `${Math.floor(t / 60)}m ago`;
  return `${fmtDuration(t)} ago`;
}

/** `120 B` · `42 KB` · `0.4 MB` · `38.2 MB` · `1.20 GB` */
export function fmtBytes(b: number): string {
  const v = Math.max(0, b);
  if (v < 1000) return `${Math.round(v)} B`;
  if (v < 100_000) return `${Math.round(v / 1000)} KB`;
  if (v < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
  return `${(v / 1e9).toFixed(2)} GB`;
}

/** `42 KB/s` · `2.8 MB/s` */
export function fmtRate(bytesPerS: number): string {
  const v = Math.max(0, bytesPerS);
  if (v < 1e6) return `${Math.round(v / 1000)} KB/s`;
  return `${(v / 1e6).toFixed(1)} MB/s`;
}

/** Plain-mode rate: `42K` · `2.8M` */
export function fmtRateShort(bytesPerS: number): string {
  const v = Math.max(0, bytesPerS);
  if (v < 1e6) return `${Math.round(v / 1000)}K`;
  return `${(v / 1e6).toFixed(1)}M`;
}

/** `1.1 Mbps` · `22 Mbps` */
export function fmtMbps(mbps: number): string {
  const v = Math.max(0, mbps);
  return v < 10 ? `${v.toFixed(1)} Mbps` : `${Math.round(v)} Mbps`;
}

/** Bare rounded milliseconds: `48` · `1800` */
export function fmtMs(ms: number): string {
  return String(Math.round(Math.max(0, ms)));
}

/** Compact with unit for reasons: `71ms` · `1.8s` · `12s` */
export function fmtMsShort(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v / 1000)}s`;
}

/** Seconds for http timings: `0.31 s` · `1.8 s` · `12 s` (spaced=false → `1.8s`) */
export function fmtSecs(ms: number, spaced = true): string {
  const v = Math.max(0, ms) / 1000;
  const sp = spaced ? ' ' : '';
  if (v < 1) return `${v.toFixed(2)}${sp}s`;
  if (v < 10) return `${v.toFixed(1)}${sp}s`;
  return `${Math.round(v)}${sp}s`;
}

/** `2%` · `18%` */
export function fmtPct(p: number): string {
  return `${Math.round(p)}%`;
}

/** Local `HH:MM:SS` */
export function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local `HH:MM` */
export function fmtHm(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---- ANSI-aware width handling ------------------------------------------------

/** CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ST`) sequences. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_RE_STICKY = new RegExp(ANSI_RE.source, 'y');
const RESET = '\x1b[0m';

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Terminal cell width of one code point. Block/check/arrow glyphs (§8.1) are 1. */
export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Visible width ignoring escape sequences. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Pad with spaces to visible width w (never truncates). */
export function padEnd(s: string, w: number): string {
  const vw = visibleWidth(s);
  return vw >= w ? s : s + ' '.repeat(w - vw);
}

/** Left-pad with spaces to visible width w (never truncates). */
export function padStart(s: string, w: number): string {
  const vw = visibleWidth(s);
  return vw >= w ? s : ' '.repeat(w - vw) + s;
}

/** Cut to at most w visible cells, keeping escape sequences; appends a reset if cut mid-style. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  let out = '';
  let width = 0;
  let i = 0;
  let sawEsc = false;
  let cut = false;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      ANSI_RE_STICKY.lastIndex = i;
      const m = ANSI_RE_STICKY.exec(s);
      if (m) {
        out += m[0];
        i += m[0].length;
        sawEsc = true;
        continue;
      }
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (width + cw > w) {
      cut = true;
      break;
    }
    out += ch;
    width += cw;
    i += ch.length;
  }
  return cut && sawEsc ? out + RESET : out;
}

/** Truncate then pad: exactly w visible cells. */
export function fit(s: string, w: number): string {
  return padEnd(truncate(s, w), w);
}
