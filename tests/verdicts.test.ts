import { test, expect } from 'bun:test';
import { activityVerdicts, REASON_MAX } from '../src/model/verdicts';
import type { VerdictInputs } from '../src/model/verdicts';
import type { DropStats } from '../src/model/types';
import { GLYPHS } from '../src/ui/ansi';

const drops = (o: Partial<DropStats> = {}): DropStats => ({
  drops15: 0, drops60: 0, dropsSession: 0, dropMedianS: null, dropLongestS: null, dropUnder30: 0,
  dropGapS: null, sinceLastDrop: null, uptime15: 100, uptime60: 100, ...o,
});

const http = (ms: number): VerdictInputs['http'] => ({
  kind: 'ok', detector: 'apple', url: '', code: 200, exitCode: 0, startedAt: 0, ms, connectMs: 40,
  redirectUrl: null, at: 0, ageS: 3,
});
const dns = (ms: number): VerdictInputs['dnsSys'] => ({ ok: true, ms, server: '1.1.1.1', status: 'NOERROR', err: null, at: 0, ageS: 3 });
const speedOf = (mbps: number): VerdictInputs['speed'] => ({
  ok: true, downMbps: mbps, bytes: 250000, ms: 200, code: 200, why: null, at: 0, ageS: 10,
});

function snap(o: Partial<VerdictInputs> = {}): VerdictInputs {
  const s: VerdictInputs = {
    state: 'UP', cause: null, loss60: 0, lossGrade: 0, latencyMs: 50, latencySource: 'icmp',
    rttOffset: 0, jitter: 10,
    grade: { grade: 'A', raw: 'A', tags: [], underLoad: false }, drops: drops(),
    dnsOk: true, dnsSys: dns(30), http: http(300), speed: null, speedValid: false, ...o,
  };
  // §7.2: lossGrade is what the verdicts grade on; a case that only names loss60 means that
  // loss is the steady-run loss too. A case that pins lossGrade (the steady-run test) wins.
  if (o.lossGrade === undefined) s.lossGrade = s.loss60;
  return s;
}
const withDrops = (o: Partial<DropStats>) => snap({ drops: drops(o) });
const withGrade = (g: 'A' | 'B' | 'C' | 'D' | null, extra: Partial<VerdictInputs> = {}) =>
  snap({ grade: { grade: g, raw: g, tags: [], underLoad: false }, ...extra });
const get = (s: VerdictInputs, i: number) => activityVerdicts(s)[i]!;
const CHAT = 0, BROWSE = 1, VIDEO = 2, DOWNLOAD = 3;

test('order and names; all OK on a clean link', () => {
  const v = activityVerdicts(snap());
  expect(v.map((x) => x.name)).toEqual(['CHAT', 'BROWSE', 'VIDEO CALL', 'DOWNLOAD']);
  expect(v.map((x) => x.level)).toEqual(['OK', 'OK', 'OK', 'OK']);
  expect(v.slice(0, 3).map((x) => x.reason)).toEqual(['', '', '']);
  expect(v[DOWNLOAD]!.reason).toBe('untested (t)');
});

test('WARMUP → ? everywhere; offline → NO offline / portal login', () => {
  expect(activityVerdicts(snap({ state: 'WARMUP' })).map((x) => x.level)).toEqual(['?', '?', '?', '?']);
  for (const state of ['DOWN', 'NO_LINK'] as const) {
    const v = activityVerdicts(snap({ state, cause: 'uplink' }));
    expect(v.map((x) => x.level)).toEqual(['NO', 'NO', 'NO', 'NO']);
    expect(v.map((x) => x.reason)).toEqual(['offline', 'offline', 'offline', 'offline']);
  }
  const p = activityVerdicts(snap({ state: 'PORTAL', cause: 'portal' }));
  expect(p.map((x) => x.reason)).toEqual(['portal login', 'portal login', 'portal login', 'portal login']);
});

// ---- CHAT -----------------------------------------------------------------------

test('CHAT: loss > 15, R > 1500, sinceDrop < 30', () => {
  expect(get(snap({ loss60: 15 }), CHAT).level).toBe('OK');
  expect(get(snap({ loss60: 18 }), CHAT)).toEqual({ name: 'CHAT', level: 'SHAKY', reason: 'loss 18%' });
  expect(get(snap({ latencyMs: 1500 }), CHAT).level).toBe('OK');
  expect(get(snap({ latencyMs: 1800 }), CHAT).reason).toBe('slow 1.8s');
  expect(get(withDrops({ sinceLastDrop: 29 }), CHAT).reason).toBe('just came back');
  expect(get(withDrops({ sinceLastDrop: 30 }), CHAT).level).toBe('OK');
  expect(get(snap({ loss60: null, latencyMs: null }), CHAT).level).toBe('OK');
});

test('CHAT: satellite offset applies to the comparison, reason shows the absolute RTT', () => {
  expect(get(snap({ latencyMs: 2100, rttOffset: 600 }), CHAT).level).toBe('OK');
  expect(get(snap({ latencyMs: 2200, rttOffset: 600 }), CHAT).reason).toBe('slow 2.2s');
});

// ---- BROWSE ---------------------------------------------------------------------

test('BROWSE: DNS failing is NO; each SHAKY rule at its boundary', () => {
  expect(get(snap({ dnsOk: false }), BROWSE)).toEqual({ name: 'BROWSE', level: 'NO', reason: 'DNS failing' });
  expect(get(withGrade('D'), BROWSE).reason).toBe('grade D');
  expect(get(withGrade('C'), BROWSE).level).toBe('OK');
  expect(get(snap({ loss60: 8 }), BROWSE).level).toBe('OK');
  expect(get(snap({ loss60: 12 }), BROWSE).reason).toBe('loss 12%');
  expect(get(snap({ latencyMs: 600 }), BROWSE).level).toBe('OK');
  expect(get(snap({ latencyMs: 800 }), BROWSE).reason).toBe('slow 0.8s');
  expect(get(snap({ http: http(2000) }), BROWSE).level).toBe('OK');
  expect(get(snap({ http: http(2400) }), BROWSE).reason).toBe('pages 2.4s');
  expect(get(snap({ dnsSys: dns(500) }), BROWSE).level).toBe('OK');
  expect(get(snap({ dnsSys: dns(580) }), BROWSE).reason).toBe('DNS 580ms');
  expect(get(withDrops({ sinceLastDrop: 29 }), BROWSE).reason).toBe('just came back');
  expect(get(snap({ http: null, dnsSys: null }), BROWSE).level).toBe('OK');
});

// ---- VIDEO CALL -----------------------------------------------------------------

test('VIDEO OK boundaries: L ≤ 3, J ≤ 50, R ≤ 250, sinceDrop ≥ 300, drops15 ≤ 1, speed ≥ 1.5', () => {
  const ok = snap({ loss60: 3, jitter: 50, latencyMs: 250, speed: speedOf(1.5), speedValid: true, drops: drops({ sinceLastDrop: 300, drops15: 1 }) });
  expect(get(ok, VIDEO)).toEqual({ name: 'VIDEO CALL', level: 'OK', reason: '' });
  expect(get(withGrade('B'), VIDEO).level).toBe('OK');
  expect(get(snap({ latencyMs: 700, rttOffset: 600 }), VIDEO).level).toBe('OK');
});

test('VIDEO SHAKY: first failed OK rule, with · audio ok when L ≤ 5 && J ≤ 60', () => {
  expect(get(snap({ jitter: 71 }), VIDEO)).toEqual({ name: 'VIDEO CALL', level: 'SHAKY', reason: 'jitter 71ms' });
  expect(get(snap({ jitter: 51 }), VIDEO).reason).toBe('jitter 51ms · audio ok');
  expect(get(snap({ loss60: 4 }), VIDEO).reason).toBe('loss 4% · audio ok');
  expect(get(snap({ loss60: 5.5 }), VIDEO).reason).toBe('loss 6%');
  expect(get(snap({ latencyMs: 251 }), VIDEO).reason).toBe('slow 251ms · audio ok');
  expect(get(withDrops({ sinceLastDrop: 240 }), VIDEO).reason).toBe('drop 4m ago · audio ok');
  expect(get(withDrops({ drops15: 3 }), VIDEO).reason).toBe('3 drops/15m · audio ok');
  expect(get(snap({ speed: speedOf(1.1), speedValid: true }), VIDEO).reason).toBe('down 1.1 Mbps · audio ok');
  expect(get(snap({ speed: speedOf(1.1), speedValid: false }), VIDEO).level).toBe('OK'); // expired test
  expect(get(withGrade('C', { state: 'DEGRADED', cause: 'quality' }), VIDEO).reason).toBe('grade C · audio ok');
  expect(get(withGrade('A', { state: 'DEGRADED', cause: 'dns' }), VIDEO).reason).toBe('DNS failing · audio ok');
  expect(get(withGrade('A', { state: 'DEGRADED', cause: 'web' }), VIDEO).reason).toBe('web failing · audio ok');
  expect(get(withGrade(null), VIDEO).reason).toBe('no grade yet · audio ok');
});

test('VIDEO NO: L > 8, J > 100, R > 400, sinceDrop < 60', () => {
  expect(get(snap({ loss60: 8 }), VIDEO).level).toBe('SHAKY');
  expect(get(snap({ loss60: 12 }), VIDEO)).toEqual({ name: 'VIDEO CALL', level: 'NO', reason: 'loss 12%' });
  expect(get(snap({ jitter: 100 }), VIDEO).level).toBe('SHAKY');
  expect(get(snap({ jitter: 140 }), VIDEO).reason).toBe('jitter 140ms');
  expect(get(snap({ latencyMs: 400 }), VIDEO).level).toBe('SHAKY');
  expect(get(snap({ latencyMs: 1800 }), VIDEO).reason).toBe('slow 1.8s');
  expect(get(withDrops({ sinceLastDrop: 60 }), VIDEO).level).toBe('SHAKY');
  expect(get(withDrops({ sinceLastDrop: 40 }), VIDEO).reason).toBe('drop 40s ago');
});

// ---- DOWNLOAD -------------------------------------------------------------------

test('DOWNLOAD OK: grade A–C, uptime15 ≥ 97, sinceDrop ≥ 300, speed ≥ 8 (or untested)', () => {
  expect(get(snap({ speed: speedOf(22), speedValid: true }), DOWNLOAD)).toEqual({ name: 'DOWNLOAD', level: 'OK', reason: '↓22 Mbps' });
  expect(get(withGrade('C'), DOWNLOAD).level).toBe('OK');
  expect(get(withDrops({ uptime15: 97, sinceLastDrop: 300 }), DOWNLOAD).level).toBe('OK');
  expect(get(snap({ speed: speedOf(8), speedValid: true }), DOWNLOAD).reason).toBe('↓8.0 Mbps');
});

test('DOWNLOAD SHAKY: uptime15 ≥ 85 and drops15 ≤ 2, with the most specific reason', () => {
  expect(get(snap({ speed: speedOf(2.1), speedValid: true }), DOWNLOAD)).toEqual({ name: 'DOWNLOAD', level: 'SHAKY', reason: 'down 2.1 Mbps' });
  expect(get(withDrops({ sinceLastDrop: 240, uptime15: 96 }), DOWNLOAD).reason).toBe('drop 4m ago');
  expect(get(withDrops({ uptime15: 96 }), DOWNLOAD).reason).toBe('use curl -C - (resumable)');
  expect(get(withGrade('D'), DOWNLOAD).reason).toBe('use curl -C - (resumable)');
  expect(get(withGrade('A', { state: 'DEGRADED', cause: 'dns' }), DOWNLOAD).level).toBe('SHAKY');
  expect(get(withDrops({ uptime15: 85, drops15: 2 }), DOWNLOAD).level).toBe('SHAKY');
});

test('DOWNLOAD NO: drops15 > 2 or uptime15 < 85', () => {
  expect(get(withDrops({ drops15: 3, sinceLastDrop: 600 }), DOWNLOAD)).toEqual({ name: 'DOWNLOAD', level: 'NO', reason: '3 drops/15m' });
  expect(get(withDrops({ drops15: 3, sinceLastDrop: 252, uptime15: 91 }), DOWNLOAD).reason).toBe('3 drops/15m'); // §8.1 mockup
  expect(get(withDrops({ uptime15: 71 }), DOWNLOAD).reason).toBe('uptime 71%');
  expect(get(withDrops({ uptime15: 84.9, drops15: 3 }), DOWNLOAD).reason).toBe('3 drops/15m');
});

// ---- DEGRADED causes, latency source, glyphs ---------------------------------------

test('BROWSE is not OK while web requests fail (DEGRADED/web)', () => {
  expect(get(snap({ state: 'DEGRADED', cause: 'web' }), BROWSE))
    .toEqual({ name: 'BROWSE', level: 'NO', reason: 'web failing' });
});

test('a passing grade is never the reason for a failing verdict during the recovery debounce', () => {
  expect(get(withGrade('B', { state: 'DEGRADED', cause: 'quality' }), VIDEO).reason).toBe('recovering · audio ok');
  expect(get(withGrade('C', { state: 'DEGRADED', cause: 'quality' }), VIDEO).reason).toBe('grade C · audio ok');
});

test('the satellite offset applies to ICMP RTT only, not to the HTTP proxy RTT (§7.1)', () => {
  expect(get(snap({ latencyMs: 400, rttOffset: 600 }), VIDEO).level).toBe('OK');
  expect(get(snap({ latencyMs: 400, latencySource: 'http', rttOffset: 600 }), VIDEO).reason).toBe('slow 400ms · audio ok');
});

test('loss for verdicts is the steady-run loss when the snapshot carries one', () => {
  expect(get(snap({ loss60: 20, lossGrade: 0 }), CHAT).level).toBe('OK');
  expect(get(snap({ loss60: 20 }), CHAT).reason).toBe('loss 20%');
});

test('--ascii: verdict reasons come from the glyph table', () => {
  const a = activityVerdicts(snap({ jitter: 51, speed: speedOf(22), speedValid: true }), GLYPHS.ascii);
  expect(a[VIDEO]?.reason).toBe('jitter 51ms | audio ok');
  expect(a[DOWNLOAD]?.reason).toBe('v22 Mbps');
  for (const v of a) expect(v.reason).toMatch(/^[\x20-\x7e]*$/);
});

// ---- reason length ----------------------------------------------------------------

test('every reason is ≤ 28 chars across a battery of snapshots', () => {
  const battery: VerdictInputs[] = [
    snap(), snap({ state: 'WARMUP' }), snap({ state: 'PORTAL', cause: 'portal' }),
    snap({ loss60: 100, jitter: 9999, latencyMs: 99_999, http: http(99_999), dnsSys: dns(99_999) }),
    withDrops({ sinceLastDrop: 3599, drops15: 99, uptime15: 0.4 }),
    withDrops({ sinceLastDrop: 3661, uptime15: 90 }),
    snap({ speed: speedOf(0.05), speedValid: true, jitter: 60, loss60: 5 }),
    withGrade(null, { state: 'DEGRADED', cause: 'quality' }),
    snap({ dnsOk: false, loss60: null, jitter: null, latencyMs: null, http: null, dnsSys: null }),
  ];
  for (const s of battery) {
    for (const v of activityVerdicts(s)) expect(v.reason.length).toBeLessThanOrEqual(REASON_MAX);
  }
  expect(REASON_MAX).toBe(28);
});
