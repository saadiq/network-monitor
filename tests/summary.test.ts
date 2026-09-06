import { test, expect } from 'bun:test';
import { quitReport, causeLabel } from '../src/model/summary';
import { makeSnapshot, makeGrade, makeOutage, makeVerdicts, wallAt, NO_DROPS, makeDrops } from './helpers/snapshot';
import { GLYPHS } from '../src/ui/ansi';

test('§8.6 mockup report, exact layout', () => {
  expect(quitReport(makeSnapshot())).toBe([
    'netmon 14:32:07 — 18m44s on en1 (gw 192.168.0.1). UP (B): internet 48ms p50 / 86 p95, loss 2%, jitter 71ms, Wi-Fi -72 dBm.',
    '3 drops (median 22s, longest 1m04s), last ended 4m12s ago, uptime 15m 91%. Chat OK · Browse OK · Video shaky (jitter 71ms) · Downloads no (3 drops/15m).',
    'Probe traffic 0.4 MB.',
    ' #  started   lasted  cause',
    ' 3  14:27:55  22s     uplink (router fine)',
    ' 2  14:21:10  1m04s   portal login needed',
    ' 1  14:19:02  9s      wi-fi link lost',
  ].join('\n'));
});

test('no drops, no table, nulls rendered as em dash', () => {
  const snap = makeSnapshot({
    drops: NO_DROPS, outages: [], latencyMs: null, latencyP95: null, loss60: null, jitter: null, wifi: null,
    grade: makeGrade({ grade: null }), verdicts: makeVerdicts({ 'VIDEO CALL': { level: 'OK', reason: '' }, DOWNLOAD: { level: 'OK', reason: 'untested (t)' } }),
  });
  expect(quitReport(snap)).toBe([
    'netmon 14:32:07 — 18m44s on en1 (gw 192.168.0.1). UP: internet — p50 / — p95, loss —, jitter —.',
    'No drops, uptime 15m 100%. Chat OK · Browse OK · Video OK · Downloads OK.',
    'Probe traffic 0.4 MB.',
  ].join('\n'));
});

test('offline headline shows cause; open outage listed first as ongoing', () => {
  const open = makeOutage({ n: 4, state: 'DOWN', cause: 'router', startedAt: wallAt('14:31:25'), endedAt: null, durationS: 42 });
  const snap = makeSnapshot({
    state: 'DOWN', cause: 'router', grade: makeGrade({ grade: null }), downFor: 42, openOutage: open,
    verdicts: makeVerdicts({ CHAT: { level: 'NO', reason: 'offline' }, BROWSE: { level: 'NO', reason: 'offline' }, 'VIDEO CALL': { level: 'NO', reason: 'offline' }, DOWNLOAD: { level: 'NO', reason: 'offline' } }),
  });
  const lines = quitReport(snap).split('\n');
  expect(lines[0]).toStartWith('netmon 14:32:07 — 18m44s on en1 (gw 192.168.0.1). DOWN (router): ');
  expect(lines[1]).toEndWith('Chat no (offline) · Browse no (offline) · Video no (offline) · Downloads no (offline).');
  expect(lines[4]).toBe(' 4  14:31:25  42s     router unreachable (ongoing)');
  expect(lines[5]).toBe(' 3  14:27:55  22s     uplink (router fine)');
});

test('single drop, sleep-closed row, http latency source, no route', () => {
  const outages = [makeOutage({ n: 1, cause: 'uplink', startedAt: wallAt('14:00:00'), durationS: 30, sleep: true })];
  const snap = makeSnapshot({
    route: null, outages, drops: makeDrops({ dropsSession: 1, drops15: 0, dropMedianS: 30, dropLongestS: 30, sinceLastDrop: 1900, uptime15: null }),
    icmpBlocked: true, latencySource: 'http', latencyMs: 120, latencyP95: null,
  });
  const lines = quitReport(snap).split('\n');
  expect(lines[0]).toBe('netmon 14:32:07 — 18m44s on ?. UP (B): internet 120ms p50 (http), loss 2%, jitter 71ms, Wi-Fi -72 dBm.');
  expect(lines[1]).toStartWith('1 drop (30s), last ended 31m40s ago. ');
  expect(lines[4]).toBe(' 1  14:00:00  30s     uplink (router fine) (closed by sleep)');
});

test('wide n column stays aligned', () => {
  const outages = Array.from({ length: 12 }, (_, i) => makeOutage({ n: 12 - i, startedAt: wallAt('14:00:00') + i * 60000 }));
  const lines = quitReport(makeSnapshot({ outages })).split('\n');
  expect(lines[3]).toBe(' #  started   lasted  cause');
  expect(lines[4]).toStartWith('12  14:00:00  22s     ');
  expect(lines[15]).toStartWith(' 1  14:11:00  22s     ');
});

test('causeLabel table', () => {
  expect(causeLabel('uplink')).toBe('uplink (router fine)');
  expect(causeLabel('portal')).toBe('portal login needed');
  expect(causeLabel('wifi')).toBe('wi-fi link lost');
  expect(causeLabel('router')).toBe('router unreachable');
  expect(causeLabel('not-joined')).toBe('not joined to wi-fi');
  expect(causeLabel('no-dhcp')).toBe('no DHCP address');
  expect(causeLabel('unknown')).toBe('no route');
  expect(causeLabel(null)).toBe('unknown');
});

test('--ascii report stays ASCII, verdicts joined with the ascii separator', () => {
  const report = quitReport(makeSnapshot(), GLYPHS.ascii);
  expect(report.split('\n')[1]).toContain('Chat OK | Browse OK | Video shaky (jitter 71ms) | Downloads no (3 drops/15m).');
  expect(report).toMatch(/^[\x20-\x7e\n]*$/);
});
