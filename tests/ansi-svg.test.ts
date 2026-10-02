import { test, expect } from 'bun:test';
import { ansiToSvg, parseLine } from '../scripts/ansi-svg';

test('parseLine: one cell per character, carrying the SGR state netmon emits', () => {
  const cells = parseLine('a\x1b[32mbc\x1b[39md');
  expect(cells.map((c) => c.ch).join('')).toBe('abcd');
  expect(cells.map((c) => c.style.fg)).toEqual(['default', 'green', 'green', 'default']);
  const badge = parseLine('\x1b[7m\x1b[1m\x1b[32m UP \x1b[39m\x1b[22m\x1b[27m!');
  expect(badge[1]?.style).toEqual({ fg: 'green', bold: true, dim: false, inverse: true });
  expect(badge[4]?.style).toEqual({ fg: 'default', bold: false, dim: false, inverse: false });
  expect(parseLine('\x1b[2mx\x1b[22m\x1b[0my').map((c) => c.style.dim)).toEqual([true, false]);
});

test('ansiToSvg: an svg document with escaped text in a monospace grid', () => {
  const svg = ansiToSvg(['  hi & <x>'], { cols: 10, rows: 1 });
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain('hi &amp; &lt;x&gt;');
  expect(svg).toContain('textLength="');
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
});

test('colors, dim and inverse become fills, opacity and a background block', () => {
  expect(ansiToSvg(['\x1b[32mok\x1b[39m'], { cols: 2, rows: 1 })).toContain('fill="#3fb950"');
  expect(ansiToSvg(['\x1b[2mdim\x1b[22m'], { cols: 3, rows: 1 })).toContain('fill-opacity="0.55"');
  const inv = ansiToSvg(['\x1b[7m\x1b[32m UP \x1b[39m\x1b[27m'], { cols: 4, rows: 1 });
  expect(inv).toMatch(/<rect [^>]*fill="#3fb950"/);
  expect(inv).toMatch(/<text [^>]*fill="#0d1117"/);
});

test('block glyphs are drawn as rects (seamless chart and timeline), not font glyphs', () => {
  const svg = ansiToSvg(['\x1b[32m▄█\x1b[39m\x1b[35m▒\x1b[39m'], { cols: 3, rows: 1 });
  expect(svg).not.toMatch(/[▄█▒]/);
  expect(svg).toMatch(/<rect [^>]*height="9"[^>]*fill="#3fb950"/);
  expect(svg).toMatch(/<rect [^>]*height="18"[^>]*fill="#3fb950"/);
  expect(svg).toMatch(/<rect [^>]*fill="#bc8cff"[^>]*fill-opacity="0.55"/);
});
