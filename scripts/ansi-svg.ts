// ANSI frame → SVG "terminal screenshot" for the README (dev tooling; not part of netmon itself).
// Understands the SGR subset netmon emits (§8.1): 0, 1, 2, 22, 7, 27, 31/32/33/35, 39. Block glyphs
// (chart bars, timeline cells) are drawn as rects so they tile seamlessly in any font. Pure.

type Fg = 'default' | 'red' | 'green' | 'yellow' | 'magenta';
export interface Style { fg: Fg; bold: boolean; dim: boolean; inverse: boolean }
export interface Cell { ch: string; style: Style }
export interface SvgOptions { cols: number; rows: number; title?: string }

/** GitHub-dark-ish terminal palette. */
const PALETTE: Readonly<Record<Fg | 'bg' | 'chrome', string>> = {
  bg: '#0d1117', chrome: '#8b949e', default: '#c9d1d9',
  red: '#f85149', green: '#3fb950', yellow: '#d29922', magenta: '#bc8cff',
};
const FG_CODES: Readonly<Record<number, Fg>> = { 31: 'red', 32: 'green', 33: 'yellow', 35: 'magenta', 39: 'default' };
const PLAIN: Style = { fg: 'default', bold: false, dim: false, inverse: false };
const DIM_OPACITY = 0.55;

const FONT_SIZE = 14;
const CW = 8.4; // cell width (0.6 em, the advance of common monospace fonts)
const LH = 18; // line height
const PAD = 16;
const TITLE_H = 28;
const FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

const EIGHTHS = '▁▂▃▄▅▆▇█'; // k/8 of a cell, bottom-aligned
const SHADES: Readonly<Record<string, number>> = { '▓': 0.75, '▒': 0.55, '░': 0.45 }; // full-height, translucent

function applySgr(s: Style, params: string): Style {
  let st = { ...s };
  for (const c of (params === '' ? '0' : params).split(';').map(Number)) {
    if (c === 0) st = { ...PLAIN };
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 22) st = { ...st, bold: false, dim: false };
    else if (c === 7) st.inverse = true;
    else if (c === 27) st.inverse = false;
    else if (FG_CODES[c]) st.fg = FG_CODES[c];
  }
  return st;
}

/** One frame line → one cell per code point (netmon's glyphs are all single-width). */
export function parseLine(line: string): Cell[] {
  const cells: Cell[] = [];
  let style: Style = { ...PLAIN };
  let last = 0;
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    for (const ch of line.slice(last, m.index)) cells.push({ ch, style });
    style = applySgr(style, m[1] ?? '');
    last = (m.index ?? 0) + m[0].length;
  }
  for (const ch of line.slice(last)) cells.push({ ch, style });
  return cells;
}

const n = (v: number): string => String(Number(v.toFixed(1)));
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sameStyle = (a: Style, b: Style): boolean =>
  a.fg === b.fg && a.bold === b.bold && a.dim === b.dim && a.inverse === b.inverse;
const isBlock = (ch: string): boolean => EIGHTHS.includes(ch) || ch in SHADES;

function blockRect(ch: string, count: number, style: Style, x: number, top: number): string {
  const fill = PALETTE[style.fg];
  const shade = SHADES[ch];
  if (shade !== undefined) {
    return `<rect x="${n(x)}" y="${n(top)}" width="${n(count * CW)}" height="${LH}" fill="${fill}" fill-opacity="${shade}"/>`;
  }
  const h = (LH * (EIGHTHS.indexOf(ch) + 1)) / 8;
  return `<rect x="${n(x)}" y="${n(top + LH - h)}" width="${n(count * CW)}" height="${n(h)}" fill="${fill}"/>`;
}

function textRun(text: string, style: Style, x: number, top: number): string {
  const w = text.length * CW;
  let out = '';
  let fill = PALETTE[style.fg];
  if (style.inverse) {
    out += `<rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${LH}" fill="${fill}"/>`;
    fill = PALETTE.bg;
  }
  if (text.trim() === '') return out;
  const extra = (style.dim ? ` fill-opacity="${DIM_OPACITY}"` : '') + (style.bold ? ' font-weight="700"' : '');
  return out + `<text x="${n(x)}" y="${n(top + LH * 0.75)}" fill="${fill}"${extra} textLength="${n(w)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`;
}

/** SVG elements for one row: runs of equal style; block glyphs as rects, the rest as text. */
function rowSvg(cells: Cell[], left: number, top: number): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const first = cells[i];
    if (!first) break;
    let j = i + 1;
    if (isBlock(first.ch)) {
      while (j < cells.length && cells[j]?.ch === first.ch && sameStyle(cells[j]!.style, first.style)) j++;
      out += blockRect(first.ch, j - i, first.style, left + i * CW, top);
    } else {
      while (j < cells.length && !isBlock(cells[j]!.ch) && sameStyle(cells[j]!.style, first.style)) j++;
      out += textRun(cells.slice(i, j).map((c) => c.ch).join(''), first.style, left + i * CW, top);
    }
    i = j;
  }
  return out;
}

function chrome(w: number, title: string | undefined): string {
  const dots = ['#ff5f57', '#febc2e', '#28c840']
    .map((c, k) => `<circle cx="${20 + k * 20}" cy="${TITLE_H / 2}" r="6" fill="${c}"/>`).join('');
  const label = title
    ? `<text x="${n(w / 2)}" y="${TITLE_H / 2 + 4}" fill="${PALETTE.chrome}" font-size="12" text-anchor="middle">${esc(title)}</text>`
    : '';
  return dots + label;
}

/** A complete SVG: rounded dark window, title bar, `rows` lines of `cols` cells. */
export function ansiToSvg(lines: string[], o: SvgOptions): string {
  const w = PAD * 2 + o.cols * CW;
  const h = TITLE_H + PAD / 2 + o.rows * LH + PAD;
  const body = lines.slice(0, o.rows).map((l, r) => rowSvg(parseLine(l), PAD, TITLE_H + PAD / 2 + r * LH)).join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}"`
      + ` font-family="${FONT}" font-size="${FONT_SIZE}" xml:space="preserve">`,
    `<rect width="100%" height="100%" rx="10" fill="${PALETTE.bg}"/>`,
    chrome(w, o.title),
    body,
    '</svg>',
    '',
  ].join('\n');
}
