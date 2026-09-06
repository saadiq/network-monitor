import { test, expect } from 'bun:test';
import { JsonlLogger, TICK_KEYS, errCode, metaRow, tickRow, type SinkLike } from '../src/log/jsonl';
import { gapEvent, outageEvent, routeEvent, speedEvent, transitionEvent, wifiEvent } from '../src/log/events';
import { NOW, T0_WALL, STARTED_WALL, makeGrade, makeOutage, makeRoute, makeSnapshot, makeSpeed, makeWifi, wallAt } from './helpers/snapshot';

const SCRATCH = (process.env['TMPDIR'] ?? '/tmp').replace(/\/$/, '');

// ---- tickRow (pure) ------------------------------------------------------------

test('tickRow: exact §11 key order and mockup values', () => {
  const row = tickRow(makeSnapshot());
  expect(Object.keys(row)).toEqual([...TICK_KEYS]);
  expect(row).toEqual({
    kind: 'tick', t: T0_WALL, m: NOW, state: 'UP', cause: null, grade: 'B', sat: false,
    gwRtt: null, gwLoss60: 0, inetRtt: 40 + (59 % 7) * 3, p50: 48, p95: 86, jitter: 71,
    loss10: 0, loss60: 2, late60: 0, unmeasured60: 0, http: 'ok', httpMs: 310,
    dnsDirectMs: 31, dnsSysMs: 380, dnsOk: true, rssi: -72, noise: -95, txRate: 216,
    inKBs: 42, outKBs: 6, loaded: false, icmpBlocked: false,
  });
});

test('tickRow: unknowns are null, never undefined (survive JSON round-trip)', () => {
  const snap = makeSnapshot({
    http: null, dnsDirect: null, dnsSys: null, wifi: null, inKBs: null, outKBs: null,
    rttHistory: [], grade: makeGrade({ grade: null, raw: null }), state: 'WARMUP', cause: null,
    gw: { ...makeSnapshot().gw, loss60: null }, inet: { ...makeSnapshot().inet, p50: null, p95: null, jitter: null, loss10: null, loss60: null },
  });
  const row = tickRow(snap);
  const back = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  expect(Object.keys(back)).toEqual([...TICK_KEYS]);
  for (const k of ['grade', 'gwRtt', 'gwLoss60', 'inetRtt', 'p50', 'p95', 'jitter', 'loss10', 'loss60', 'http', 'httpMs', 'dnsDirectMs', 'dnsSysMs', 'rssi', 'noise', 'txRate', 'inKBs', 'outKBs']) {
    expect(back[k]).toBeNull();
  }
  expect(back['state']).toBe('WARMUP');
  expect(back['dnsOk']).toBe(true);
});

test('tickRow: inetRtt is the latest inet sample (null when LOST); extras override, 1-decimal rounding', () => {
  expect(tickRow(makeSnapshot({ rttHistory: [40, 50, null] })).inetRtt).toBeNull();
  expect(tickRow(makeSnapshot({ rttHistory: [40, 48.26] })).inetRtt).toBe(48.3);
  const row = tickRow(makeSnapshot(), { gwRtt: 7.14, inetRtt: 51.96 });
  expect(row.gwRtt).toBe(7.1);
  expect(row.inetRtt).toBe(52);
  expect(tickRow(makeSnapshot(), { gwRtt: null }).gwRtt).toBeNull();
});

test('tickRow: m is integer ms since start; t is the tick wall clock', () => {
  const row = tickRow(makeSnapshot({ now: 1234.56, startedAt: 34.1, wall: 1_757_168_004_123 }));
  expect(row.m).toBe(1200);
  expect(row.t).toBe(1_757_168_004_123);
  expect(row.gwLoss60).toBe(0);
});

test('metaRow matches the §11 meta line', () => {
  const m = metaRow({ argv: ['--target', '1.1.1.1'], target: '1.1.1.1', iface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', vpn: false }, 1_757_168_003_123);
  expect(m).toEqual({ kind: 'meta', v: 1, t: 1_757_168_003_123, m: 0, argv: ['--target', '1.1.1.1'], iface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', target: '1.1.1.1', vpn: false });
  expect(metaRow({}, 5)).toEqual({ kind: 'meta', v: 1, t: 5, m: 0, argv: [], iface: null, wifiIface: null, gateway: null, target: null, vpn: false });
});

test('event builders produce the §11 payloads', () => {
  const t = transitionEvent({ from: 'UP', to: 'DOWN', cause: 'uplink', at: 40_000, wall: 1_757_168_040_500, startedAt: 1_757_168_040_000, startedAtMono: 39_500 });
  expect(t).toEqual({ event: 'transition', from: 'UP', to: 'DOWN', cause: 'uplink', startedAt: 1_757_168_040_000 });
  const o = outageEvent(makeOutage({ startedAt: 1_757_168_040_000, durationS: 22 }));
  expect(o).toEqual({ event: 'outage', cause: 'uplink', startedAt: 1_757_168_040_000, endedAt: 1_757_168_062_000, durationS: 22, sleep: false });
  expect(routeEvent(makeRoute())).toEqual({ event: 'route', iface: 'en1', gateway: '192.168.0.1', vpn: false });
  expect(routeEvent(makeRoute({ egressIface: 'utun9', vpn: true }))).toEqual({ event: 'route', iface: 'utun9', gateway: '192.168.0.1', vpn: true });
  expect(speedEvent(makeSpeed())).toEqual({ event: 'speed', downMbps: 22.4, bytes: 250000, ms: 180 });
  expect(gapEvent(1_757_169_000_000, 1_757_170_210_000)).toEqual({ event: 'gap', fromT: 1_757_169_000_000, toT: 1_757_170_210_000, gapS: 1210 });
  // the store derives fromT by float arithmetic; every timestamp in the log is integer ms
  expect(gapEvent(1_757_169_000_000.4, 1_757_170_210_000.6)).toEqual({ event: 'gap', fromT: 1_757_169_000_000, toT: 1_757_170_210_001, gapS: 1210 });
  expect(wifiEvent(makeWifi())).toEqual({ event: 'wifi', rssi: -72, noise: -95, txRate: 216, mcs: 4, channel: '157 (5GHz, 80MHz)', phy: '802.11ax', assoc: 'yes' });
});

test('errCode prefers the errno code', () => {
  expect(errCode(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))).toBe('EACCES');
  expect(errCode(new Error('boom'))).toBe('boom');
  expect(errCode('x')).toBe('x');
});

// ---- JsonlLogger (I/O) ---------------------------------------------------------

test('open → meta row; tick/event rows; close flushes; file parses line by line', async () => {
  const path = `${SCRATCH}/netmon-jsonl-${process.pid}.jsonl`;
  const lg = await JsonlLogger.open(path, { argv: ['--log'], target: '1.1.1.1', startedAt: 0, startedWall: STARTED_WALL });
  expect(lg).not.toBeNull();
  if (!lg) return;
  expect(lg.status).toBe('on');
  expect(lg.enabled).toBe(true);
  lg.tick(makeSnapshot());
  lg.event(transitionEvent({ from: 'UP', to: 'DOWN', cause: 'uplink', at: NOW, wall: T0_WALL, startedAt: wallAt('14:27:55'), startedAtMono: NOW - 3000 }), NOW + 1000, T0_WALL + 1000);
  await lg.close();
  expect(lg.enabled).toBe(false);
  const lines = (await Bun.file(path).text()).split('\n');
  expect(lines.length).toBe(4); // 3 rows + trailing newline
  expect(lines[3]).toBe('');
  const rows = lines.slice(0, 3).map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(rows[0]).toEqual({ kind: 'meta', v: 1, t: STARTED_WALL, m: 0, argv: ['--log'], iface: null, wifiIface: null, gateway: null, target: '1.1.1.1', vpn: false });
  expect(rows[1]).toEqual(JSON.parse(JSON.stringify(tickRow(makeSnapshot()))));
  expect(rows[2]).toEqual({ kind: 'event', t: T0_WALL + 1000, m: NOW + 1000, event: 'transition', from: 'UP', to: 'DOWN', cause: 'uplink', startedAt: wallAt('14:27:55') });
  // writes after close are ignored
  lg.tick(makeSnapshot());
  await lg.close();
  expect((await Bun.file(path).text()).split('\n').length).toBe(4);
  await Bun.file(path).delete();
});

test('open truncates an existing file (no stale tail from a previous session)', async () => {
  const path = `${SCRATCH}/netmon-jsonl-trunc-${process.pid}.jsonl`;
  await Bun.write(path, `${'{"kind":"old"}'.repeat(50)}\n`);
  const lg = await JsonlLogger.open(path, { startedWall: 5 });
  expect(lg).not.toBeNull();
  await lg?.close();
  const lines = (await Bun.file(path).text()).split('\n');
  expect(lines).toEqual([JSON.stringify(metaRow({}, 5)), '']);
  await Bun.file(path).delete();
});

test('open fails → null + reason (ENOENT for a missing directory)', async () => {
  const path = '/nonexistent-dir-netmon-xyz/x.jsonl';
  expect(await JsonlLogger.open(path)).toBeNull();
  const r = await JsonlLogger.tryOpen(path);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('ENOENT');
});

function fakeSink(failOnWrite: number): SinkLike & { writes: string[]; ended: boolean } {
  const s = {
    writes: [] as string[], ended: false, n: 0,
    write(chunk: string) {
      if (++s.n === failOnWrite) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      s.writes.push(chunk); return chunk.length;
    },
    flush() { return 0; },
    end() { s.ended = true; return 0; },
  };
  return s;
}

test('write error self-disables: status off (CODE), sink ended, later rows dropped', () => {
  const sink = fakeSink(2);
  const lg = new JsonlLogger('/dev/null', sink, { startedAt: 0, startedWall: STARTED_WALL });
  lg.writeMeta();
  expect(sink.writes.length).toBe(1);
  lg.tick(makeSnapshot()); // second write throws
  expect(lg.enabled).toBe(false);
  expect(lg.status).toBe('off (ENOSPC)');
  expect(sink.ended).toBe(true);
  lg.tick(makeSnapshot());
  lg.event(gapEvent(0, 10_000));
  expect(sink.writes.length).toBe(1);
});

test('async flush rejection self-disables', async () => {
  const sink: SinkLike = {
    write: (c: string) => c.length,
    flush: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
    end: () => 0,
  };
  const lg = new JsonlLogger('/dev/null', sink, {});
  lg.tick(makeSnapshot());
  await new Promise((r) => setTimeout(r, 0));
  expect(lg.status).toBe('off (EIO)');
});

test('one meta row per file, carrying the route fields known when it is written', async () => {
  const path = `${SCRATCH}/netmon-jsonl-meta-${process.pid}.jsonl`;
  const lg = await JsonlLogger.open(path, { argv: ['--log'], target: '1.1.1.1', startedAt: 0, startedWall: STARTED_WALL });
  expect(lg).not.toBeNull();
  if (!lg) return;
  lg.tick(makeSnapshot()); // written before the first route poll: keeps its place, after the meta row
  expect(lg.writeMeta({ iface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', vpn: false })).toBe(true);
  lg.writeMeta({ iface: 'utun9', vpn: true }); // later polls do not add a second meta row
  lg.tick(makeSnapshot());
  await lg.close();
  const rows = (await Bun.file(path).text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(rows.length).toBe(3);
  expect(rows[0]).toEqual({
    kind: 'meta', v: 1, t: STARTED_WALL, m: 0, argv: ['--log'],
    iface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', target: '1.1.1.1', vpn: false,
  });
  expect(rows[1]?.['kind']).toBe('tick');
  expect(rows[2]?.['kind']).toBe('tick');
  await Bun.file(path).delete();
});

test('close() still writes the meta row when nothing else did', async () => {
  const path = `${SCRATCH}/netmon-jsonl-meta-close-${process.pid}.jsonl`;
  const lg = await JsonlLogger.open(path, { target: '1.1.1.1', startedWall: 7 });
  await lg?.close();
  const lines = (await Bun.file(path).text()).split('\n');
  expect(lines).toEqual([JSON.stringify(metaRow({ target: '1.1.1.1' }, 7)), '']);
  await Bun.file(path).delete();
});
