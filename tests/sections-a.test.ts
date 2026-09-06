// UI sections A: header, banner, activities, path, sparkline (§8.1 / §8.2 mockups at 100 and 80 cols).
import { test, expect } from 'bun:test';
import { header } from '../src/ui/sections/header';
import { banner } from '../src/ui/sections/banner';
import { activities } from '../src/ui/sections/activities';
import { path } from '../src/ui/sections/path';
import { sparkline, timelineBar } from '../src/ui/sections/sparkline';
import { GLYPHS, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { makeSnapshot, ui } from './sections-a.fixture';

const G = GLYPHS.unicode;
const A = GLYPHS.ascii;
const full = { compact: false, cols: 100 };
const compact = { compact: true, cols: 80 };
const widths = (rows: string[], w: number) => rows.every((r) => visibleWidth(r) === w);

// ---- header -------------------------------------------------------------------
test('header at 100 cols matches the mockup and is right-aligned', () => {
  const [row] = header(makeSnapshot(), 100, G);
  expect(row).toBeDefined();
  const s = strip(row!);
  expect(s).toBe(' netmon  en1 · gw 192.168.0.1 · dns 100.100.100.100 (ts) · probes 0.4 MB        14:32:07  run 18m44s');
  expect(visibleWidth(row!)).toBe(100);
  expect(row).toContain('\x1b[1m'); // bold name
});

test('header at 80 cols drops probes, at 60 drops dns; sat shows in the header', () => {
  const r80 = strip(header(makeSnapshot(), 80)[0]!);
  expect(r80).toHaveLength(80);
  expect(r80).not.toContain('probes');
  expect(r80).toContain('dns 100.100.100.100 (ts)');
  expect(r80.endsWith('14:32:07  run 18m44s')).toBe(true);
  const r60 = strip(header(makeSnapshot(), 60)[0]!);
  expect(r60).toHaveLength(60);
  expect(r60).not.toContain('dns');
  expect(r60).toContain('gw 192.168.0.1');
  const sat = strip(header(makeSnapshot({ sat: true, rttOffset: 600 }), 100)[0]!);
  expect(sat).toContain('sat +600ms');
  const bare = strip(header(makeSnapshot({ route: null, dnsServer: null, vpn: false }), 100, G, false)[0]!);
  expect(bare).toContain(' netmon  — · gw — · dns —');
  expect(header(makeSnapshot(), 100, G, false)[0]).not.toContain('\x1b[');
});

// ---- banner -------------------------------------------------------------------
test('banner UP row matches the mockup; flash renders inverse', () => {
  const rows = banner(makeSnapshot(), ui(), 100, G);
  expect(rows).toHaveLength(2);
  expect(widths(rows, 100)).toBe(true);
  expect(strip(rows[0]!)).toBe('  ● UP · OK (B)      steady 4m12s      getting worse ▲      3 drops in 15m'.padEnd(100));
  expect(strip(rows[1]!)).toContain('Fine for chat & browsing. Video call shaky (jitter 71ms).');
  expect(rows[0]).toContain('\x1b[32m'); // green state
  expect(rows[0]).not.toContain('\x1b[7m');
  const flash = banner(makeSnapshot(), ui({ flashTicksLeft: 2 }), 100, G);
  expect(flash[0]!.startsWith('\x1b[7m')).toBe(true);
  expect(flash[1]!.endsWith('\x1b[27m')).toBe(true);
  expect(widths(flash, 100)).toBe(true);
});

test('banner DOWN / tags / ascii / compact spacing / no-color', () => {
  const down = makeSnapshot({ state: 'DOWN', cause: 'uplink', downFor: 42, grade: { grade: null, raw: null, tags: [], underLoad: false } });
  const [d1] = banner(down, ui(), 100, G);
  expect(strip(d1!)).toMatch(/^ {2}● DOWN · uplink {6}DOWN 0:42 {6}getting worse ▲ {6}3 drops in 15m/);
  expect(d1).toContain('\x1b[31m');
  const tagged = makeSnapshot({ sat: true, rttOffset: 600, grade: { grade: 'B', raw: 'B', tags: ['FLAKY'], underLoad: true } });
  const t1 = strip(banner(tagged, ui(), 120, G)[0]!);
  expect(t1).toContain('OK (B~)');
  expect(t1).toContain('FLAKY      sat +600ms      ~ under load');
  const asc = strip(banner(makeSnapshot(), ui(), 80, A)[0]!);
  expect(asc).toMatch(/^ {2}\* UP \| OK \(B\) {5}steady 4m12s {5}getting worse \^ {5}3 drops in 15m/);
  expect(asc).toHaveLength(80);
  const nl = makeSnapshot({ state: 'NO_LINK', cause: 'not-joined', downFor: 12, grade: { grade: null, raw: null, tags: [], underLoad: false } });
  expect(strip(banner(nl, ui(), 100, G)[0]!)).toContain('● NO LINK · not joined      NO LINK 0:12');
  const plain = banner(makeSnapshot(), ui({ flashTicksLeft: 1 }), 100, G, false);
  expect(plain.join('')).not.toContain('\x1b[');
  expect(widths(banner(makeSnapshot(), ui(), 72, G), 72)).toBe(true);
});

// ---- activities ---------------------------------------------------------------
test('activities: one row at 100 cols, two rows (3 + 1) at 80 cols', () => {
  const one = activities(makeSnapshot(), full, G);
  expect(one).toHaveLength(1);
  expect(strip(one[0]!)).toBe('  CHAT ✔ OK    BROWSE ✔ OK    VIDEO ~ SHAKY jitter 71ms · audio ok    DOWNLOAD ✘ NO 3 drops/15m'.padEnd(100));
  expect(one[0]).toContain('\x1b[32m✔\x1b[39m');
  expect(one[0]).toContain('\x1b[33m~\x1b[39m');
  expect(one[0]).toContain('\x1b[31m✘\x1b[39m');
  const two = activities(makeSnapshot(), compact, G);
  expect(two).toHaveLength(2);
  expect(widths(two, 80)).toBe(true);
  expect(strip(two[0]!)).toBe('  CHAT ✔ OK    BROWSE ✔ OK    VIDEO ~ SHAKY jitter 71ms · audio ok'.padEnd(80));
  expect(strip(two[1]!)).toBe('  DOWNLOAD ✘ NO 3 drops/15m'.padEnd(80));
});

test('activities: offline row, warmup ?, empty verdicts, ascii', () => {
  const off = ['CHAT', 'BROWSE', 'VIDEO CALL', 'DOWNLOAD'].map((name) => ({ name: name as never, level: 'NO' as const, reason: 'offline' }));
  const row = strip(activities(makeSnapshot({ verdicts: off }), full, G)[0]!);
  expect(row.trimEnd()).toBe('  CHAT ✘ NO offline    BROWSE ✘ NO offline    VIDEO ✘ NO offline    DOWNLOAD ✘ NO offline');
  const two = activities(makeSnapshot({ verdicts: off }), compact, A);
  expect(strip(two[0]!).trimEnd()).toBe('  CHAT X NO offline    BROWSE X NO offline    VIDEO X NO offline');
  expect(strip(two[1]!).trimEnd()).toBe('  DOWNLOAD X NO offline');
  const warm = strip(activities(makeSnapshot({ verdicts: [] }), full, G)[0]!);
  expect(warm.trimEnd()).toBe('  CHAT ?    BROWSE ?    VIDEO ?    DOWNLOAD ?');
  const narrow = activities(makeSnapshot({ verdicts: off }), { compact: true, cols: 72 }, G);
  expect(widths(narrow, 72)).toBe(true);
});

// ---- path ---------------------------------------------------------------------
test('path full and compact match the mockups', () => {
  const [row] = path(makeSnapshot(), full, G);
  expect(strip(row!)).toBe('  PATH  Wi-Fi ✔ -72dBm → Router ✔ 7ms → Internet ✔ 48ms → DNS ✔ 31ms (sys 380) → Web ✔ 200 OK'.padEnd(100));
  expect(row).toContain('\x1b[32m✔\x1b[39m');
  const [c] = path(makeSnapshot(), compact, G);
  expect(strip(c!)).toBe('  PATH  Wi-Fi ✔ → Router ✔ → Internet ✔ 48ms → DNS ✔ 31ms → Web ✔'.padEnd(80));
  const [asc] = path(makeSnapshot(), compact, A, false);
  expect(asc).toBe('  PATH  Wi-Fi OK -> Router OK -> Internet OK 48ms -> DNS OK 31ms -> Web OK'.padEnd(80));
});

test('path DOWN example, icmp-blocked, no-icmp router, hidden router, missing dig', () => {
  const s = makeSnapshot();
  const down = makeSnapshot({
    state: 'DOWN', cause: 'uplink', dnsDirectOk: false, dnsSysOk: false, dnsOk: false,
    http: { ...s.http!, kind: 'fail', code: null, exitCode: 7 },
    signals: { ...s.signals, inetLink: 'down', inetOk: false, inetDownSince: s.now - 42000 },
  });
  const [d] = path(down, full, G);
  expect(strip(d!).trimEnd()).toBe('  PATH  Wi-Fi ✔ -72dBm → Router ✔ 7ms → Internet ✘ no reply 42s → DNS ✘ → Web ✘ connect');
  const [dc] = path(down, compact, G);
  expect(strip(dc!).trimEnd()).toBe('  PATH  Wi-Fi ✔ → Router ✔ → Internet ✘ no reply 42s → DNS ✘ → Web ✘ connect');
  const blocked = makeSnapshot({ icmpBlocked: true, rttProxyMs: 120, signals: { ...s.signals, inetLink: 'down', inetOk: true } });
  expect(strip(path(blocked, full, G)[0]!)).toContain('Internet ✔ http 120ms');
  const noIcmp = makeSnapshot({ gwNoIcmp: true, signals: { ...s.signals, gwLink: 'down' } });
  expect(strip(path(noIcmp, full, G)[0]!)).toContain('Router – no icmp');
  expect(path(noIcmp, full, G)[0]).toContain('\x1b[2m–\x1b[22m');
  const noGw = makeSnapshot({ route: { ...s.route!, pingGateway: null } });
  expect(strip(path(noGw, full, G)[0]!)).toContain('Wi-Fi ✔ -72dBm → Internet ✔');
  const noDig = makeSnapshot({ missingBins: ['/usr/bin/dig'] });
  expect(strip(path(noDig, compact, G)[0]!)).toContain('DNS ? dig: missing');
  const nl = makeSnapshot({ state: 'NO_LINK', cause: 'not-joined', route: { ...s.route!, hasRoute: false } });
  expect(strip(path(nl, full, G)[0]!)).toContain('Wi-Fi ✘ not joined');
  const eth = makeSnapshot({ wifiStatus: 'off', wifi: null });
  expect(strip(path(eth, full, G)[0]!).startsWith('  PATH  Router ✔ 7ms')).toBe(true);
});

// ---- sparkline / timelineBar --------------------------------------------------
test('sparkline: exact width, lost glyph, log and linear scales, ascii ramp', () => {
  const lin = sparkline([0, 10, 20, 30, 40, 50, 60, 70], 8, { lostGlyph: 'x' });
  expect(lin).toBe('▁▂▃▄▅▆▇█');
  expect(sparkline([42, 42, 42], 8, { lostGlyph: 'x' })).toBe('███     ');
  const log = sparkline([8, null, 210, 8], 4, { log: true, lostGlyph: 'x' });
  expect(log).toBe('▁x█▁');
  expect(visibleWidth(log)).toBe(4);
  expect(sparkline([], 5, { lostGlyph: 'x' })).toBe('     ');
  expect(sparkline([1, 2, 3], 0, { lostGlyph: 'x' })).toBe('');
  expect(sparkline([1, 2, 4, 8], 4, { log: true, lostGlyph: 'x', ramp: A.ramp })).toBe('_-*@');
  // fixed range: 50 of 0..100 lands mid-ramp
  expect(sparkline([50], 1, { lostGlyph: 'x', min: 0, max: 100 })).toBe('▅');
});

test('timelineBar maps cells to glyphs and colors per §8.1', () => {
  const cells = ['UP', 'UP', 'DEGRADED', 'PORTAL', 'DOWN', 'NO_LINK', 'GAP', 'WARMUP'] as const;
  const bar = timelineBar([...cells], G);
  expect(strip(bar)).toBe('██▓▒░░··');
  expect(bar).toBe('\x1b[32m██\x1b[39m\x1b[33m▓\x1b[39m\x1b[35m▒\x1b[39m\x1b[31m░░\x1b[39m··');
  expect(timelineBar([...cells], A, false)).toBe('##=:....');
  expect(timelineBar([], G)).toBe('');
});

test('activities: name, mark and level survive when all four verdicts carry reasons (UI-2)', () => {
  const post = [
    { name: 'CHAT' as const, level: 'SHAKY' as const, reason: 'just came back' },
    { name: 'BROWSE' as const, level: 'SHAKY' as const, reason: 'just came back' },
    { name: 'VIDEO CALL' as const, level: 'NO' as const, reason: 'drop 12s ago' },
    { name: 'DOWNLOAD' as const, level: 'NO' as const, reason: 'drop 12s ago' },
  ];
  const snap = makeSnapshot({ verdicts: post });
  for (const cols of [100, 120]) {
    const rows = activities(snap, { compact: false, cols }, G);
    const s = strip(rows[0]!);
    expect(visibleWidth(rows[0]!)).toBe(cols);
    for (const want of ['CHAT ~ SHAKY', 'BROWSE ~ SHAKY', 'VIDEO ✘ NO', 'DOWNLOAD ✘ NO']) expect(s).toContain(want);
  }
  expect(strip(activities(snap, full, G)[0]!)).toContain('CHAT ~ SHAKY just came back');
  // the widest possible reasons (§7.4 caps them at 28) still never cost an activity its level
  const maxed = post.map((v) => ({ ...v, reason: 'x'.repeat(28) }));
  const wide = strip(activities(makeSnapshot({ verdicts: maxed }), full, G)[0]!);
  for (const want of ['CHAT ~ SHAKY', 'BROWSE ~ SHAKY', 'VIDEO ✘ NO', 'DOWNLOAD ✘ NO']) expect(wide).toContain(want);
  expect(wide).toContain('…'); // the reason that no longer fits is cut, not silently halved
  const asc = strip(activities(makeSnapshot({ verdicts: maxed }), full, A)[0]!);
  expect(asc).toContain('...');
  // two-row layouts degrade the same way
  const narrow = activities(makeSnapshot({ verdicts: maxed }), { compact: true, cols: 72 }, G);
  expect(narrow.every((r) => visibleWidth(r) === 72)).toBe(true);
  for (const want of ['CHAT ~ SHAKY', 'BROWSE ~ SHAKY', 'VIDEO ✘ NO', 'DOWNLOAD ✘ NO']) {
    expect(narrow.map(strip).join('|')).toContain(want);
  }
});

test('path sheds hop detail before truncating and never leaves a dangling arrow (UI-6)', () => {
  const s = makeSnapshot();
  const down = makeSnapshot({
    state: 'DOWN', cause: 'uplink', dnsDirectOk: false, dnsSysOk: false, dnsOk: false,
    http: { ...s.http!, kind: 'fail', code: null, exitCode: 7 },
    signals: { ...s.signals, gwLink: 'down', inetLink: 'down', inetOk: false, inetDownSince: s.now - 130000 },
  });
  for (const g of [G, A]) {
    for (const cols of [72, 80, 100]) {
      const [row] = path(down, { compact: cols < 100, cols }, g, false);
      const t = strip(row!).trimEnd();
      expect([cols, visibleWidth(row!)]).toEqual([cols, cols]);
      expect([cols, t.endsWith(g.arrow)]).toEqual([cols, false]);
      expect([cols, t.split(g.arrow).length]).toEqual([cols, 5]); // five hops, four arrows
      for (const hop of ['Wi-Fi', 'Router', 'DNS', 'Web']) expect([cols, t.includes(hop)]).toEqual([cols, true]);
      expect(t).toMatch(/Inet|Internet/);
      expect(t).toContain(`Web ${g.fail} connect`); // the last hop keeps its status
    }
  }
  // a healthy path with a failing router still fits at 100 cols by dropping healthy-hop detail
  const gwDown = makeSnapshot({ signals: { ...s.signals, gwLink: 'down' } });
  const full100 = strip(path(gwDown, full, G, false)[0]!).trimEnd();
  expect(full100).toContain('Router ✘ no reply');
  expect(full100).toContain('Web ✔ 200 OK');
});

test('path: the DNS hop follows the latest round, not a 45s-old success (UI-9)', () => {
  const s = makeSnapshot();
  const late = makeSnapshot({ dnsDirect: { ...s.dnsDirect!, ok: false, ms: null, status: null, err: 'TIMEOUT' } });
  const t = strip(path(late, full, G, false)[0]!);
  expect(t).toContain('DNS ~ direct timeout');
  expect(t).not.toContain('DNS ✔');
  const sysLate = makeSnapshot({ dnsSys: { ...s.dnsSys!, ok: false, ms: null, status: null, err: 'DNS_ERROR' } });
  expect(strip(path(sysLate, full, G, false)[0]!)).toContain('DNS ~ sys fail');
  expect(strip(path(sysLate, compact, G, false)[0]!)).toContain('DNS ~ sys fail');
  // unchanged when both resolvers answered
  expect(strip(path(s, full, G, false)[0]!)).toContain('DNS ✔ 31ms (sys 380)');
});
