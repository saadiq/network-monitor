import { test, expect } from 'bun:test';
import { evaluateCandidate } from '../src/model/status';
import type { Signals } from '../src/model/types';
import { Sim, WALL0, http, link, route, wifi } from './status-sim';

function sigOf(over: Partial<Signals> = {}): Signals {
  return {
    now: 10_000, hasRoute: true, routeAt: 9_000, assoc: null, selfAssigned: false, rssi: null, vpn: false,
    gwLink: 'up', inetLink: 'up', inetDownSince: null, gwDownSince: null, inetUpSince: null, gwUpSince: null,
    inetOk: true, icmpBlocked: false, gwNoIcmp: false, gwNoIcmpSince: null,
    portalSignal: false, portalSince: null, portalRedirectUrl: null,
    hasHttpResult: true, lastHttpKind: 'ok', httpAgeS: 2, httpStartedAt: 8_000, lastHttpOkAt: 8_000,
    dnsSysOk: true, dnsDirectOk: true, dnsOk: true, webFailStreak: 0, heldGrade: 'A', grace: false, graceUntil: null,
    gapMs: 1000, ...over,
  };
}

// §6.2 table, row by row
test('evaluateCandidate: rows 1–10 in order', () => {
  expect(evaluateCandidate(sigOf({ hasRoute: false }))).toEqual({ state: 'NO_LINK', cause: 'unknown' });
  expect(evaluateCandidate(sigOf({ hasRoute: false, assoc: 'no' }))).toEqual({ state: 'NO_LINK', cause: 'not-joined' });
  expect(evaluateCandidate(sigOf({ hasRoute: false, assoc: 'yes' }))).toEqual({ state: 'NO_LINK', cause: 'no-dhcp' });
  expect(evaluateCandidate(sigOf({ hasRoute: false, selfAssigned: true }))).toEqual({ state: 'NO_LINK', cause: 'no-dhcp' });
  expect(evaluateCandidate(sigOf({ portalSignal: true, inetOk: false }))).toEqual({ state: 'PORTAL', cause: 'portal' });
  expect(evaluateCandidate(sigOf({ inetLink: 'unknown', hasHttpResult: false, inetOk: false }))).toEqual({ state: 'WARMUP', cause: null });
  expect(evaluateCandidate(sigOf({ inetOk: false, inetLink: 'down', gwLink: 'down', rssi: -90 }))).toEqual({ state: 'DOWN', cause: 'wifi' });
  expect(evaluateCandidate(sigOf({ inetOk: false, inetLink: 'down', gwLink: 'down', assoc: 'no' }))).toEqual({ state: 'DOWN', cause: 'wifi' });
  expect(evaluateCandidate(sigOf({ inetOk: false, inetLink: 'down', gwLink: 'down', rssi: -85 }))).toEqual({ state: 'DOWN', cause: 'router' });
  expect(evaluateCandidate(sigOf({ inetOk: false, inetLink: 'down' }))).toEqual({ state: 'DOWN', cause: 'uplink' });
  expect(evaluateCandidate(sigOf({ inetOk: false, inetLink: 'down', gwLink: 'down', gwNoIcmp: true }))).toEqual({ state: 'DOWN', cause: 'uplink' });
  expect(evaluateCandidate(sigOf({ dnsSysOk: false, dnsDirectOk: false }))).toEqual({ state: 'DEGRADED', cause: 'dns' });
  expect(evaluateCandidate(sigOf({ dnsSysOk: false, lastHttpKind: 'dnsfail' }))).toEqual({ state: 'DEGRADED', cause: 'dns' });
  expect(evaluateCandidate(sigOf({ dnsSysOk: false }))).toEqual({ state: 'UP', cause: null });
  expect(evaluateCandidate(sigOf({ webFailStreak: 3 }))).toEqual({ state: 'DEGRADED', cause: 'web' });
  expect(evaluateCandidate(sigOf({ webFailStreak: 3, inetLink: 'down', icmpBlocked: true }))).toEqual({ state: 'UP', cause: null });
  expect(evaluateCandidate(sigOf({ heldGrade: 'C' }))).toEqual({ state: 'DEGRADED', cause: 'quality' });
  expect(evaluateCandidate(sigOf({ heldGrade: 'D' }))).toEqual({ state: 'DEGRADED', cause: 'quality' });
  expect(evaluateCandidate(sigOf({ heldGrade: null }))).toEqual({ state: 'UP', cause: null });
});

test('WARMUP → UP: unknown link with no captive result stays WARMUP, then UP after 2 ticks', () => {
  const s = new Sim();
  const warm = { inet: link('unknown'), gw: link('unknown') };
  expect(s.step(warm)).toBeNull();
  expect(s.sm.state).toBe('WARMUP');
  expect(s.step(warm)).toBeNull();
  expect(s.step()).toBeNull();
  const t = s.step();
  expect(t).toMatchObject({ from: 'WARMUP', to: 'UP', cause: null, at: 4_000, startedAtMono: 4_000, wall: WALL0 + 4_000 });
  expect(s.sm.state).toBe('UP');
  expect(s.sm.since).toBe(4_000);
});

test('WARMUP with unknown link but a fresh captive ok gives a fast UP verdict', () => {
  const s = new Sim();
  const w = { inet: link('unknown'), gw: link('unknown'), captive: [http('ok', 300)] };
  expect(s.step(w)).toBeNull();
  expect(s.sig.inetOk).toBe(true);
  expect(s.step(w)?.to).toBe('UP');
});

test('clean drop → DOWN(uplink) confirmed at +4 s, backdated to the first LOST; recovery backdated', () => {
  const s = new Sim();
  s.run(2);
  expect(s.sm.state).toBe('UP');
  const captive = [http('ok', 0)]; // old ok: no grace, and it predates the drop
  s.run(10, { captive });
  const down = link('down', { downSince: 10_020 });
  expect(s.step({ inet: down, captive })).toBeNull(); // t=13: first down tick
  expect(s.sig.inetOk).toBe(false);
  expect(s.sig.grace).toBe(false);
  const t = s.step({ inet: down, captive }); // t=14
  expect(t).toMatchObject({ from: 'UP', to: 'DOWN', cause: 'uplink', at: 14_000, startedAtMono: 10_020, startedAt: WALL0 + 10_020 });
  expect(s.sm.cause).toBe('uplink');
  s.run(5, { inet: down, captive });
  const up = link('up', { upSince: 19_500, lastReceivedAt: 20_500 });
  expect(s.step({ inet: up, captive })).toBeNull(); // t=20
  const r = s.step({ inet: up, captive }); // t=21
  expect(r).toMatchObject({ from: 'DOWN', to: 'UP', cause: null, at: 21_000, startedAtMono: 19_500, startedAt: WALL0 + 19_500 });
});

test('cause is fixed at open: DOWN(uplink) stays uplink when the gateway also drops later', () => {
  const s = new Sim();
  s.run(2);
  const inet = link('down', { downSince: 2_020 });
  s.run(2, { inet });
  expect(s.sm.cause).toBe('uplink');
  const ts = s.run(3, { inet, gw: link('down', { downSince: 4_000 }) });
  expect(ts).toEqual([]);
  expect(s.sm.cause).toBe('uplink');
});

test('gateway + internet loss with weak RSSI → DOWN(wifi) backdated to gwDownSince; strong RSSI → router', () => {
  const s = new Sim();
  s.run(2);
  const both = { gw: link('down', { downSince: 2_500 }), inet: link('down', { downSince: 2_600 }), wifi: wifi(-90, 'yes', 1_000) };
  expect(s.step(both)).toBeNull();
  expect(s.step(both)).toMatchObject({ to: 'DOWN', cause: 'wifi', at: 4_000, startedAtMono: 2_500 });

  const s2 = new Sim();
  s2.run(2);
  const notJoined = { gw: link('down', { downSince: 2_500 }), inet: link('down', { downSince: 2_600 }), wifi: wifi(null, 'no', 1_000) };
  s2.step(notJoined);
  expect(s2.step(notJoined)).toMatchObject({ to: 'DOWN', cause: 'wifi', startedAtMono: 2_500 });

  const s3 = new Sim();
  s3.run(2);
  const strong = { gw: link('down', { downSince: 2_500 }), inet: link('down', { downSince: 2_600 }), wifi: wifi(-60, 'yes', 1_000) };
  s3.step(strong);
  expect(s3.step(strong)).toMatchObject({ to: 'DOWN', cause: 'router', startedAtMono: 2_500 });
});

test('gateway that ignores ICMP: gwNoIcmp, stays UP, and a later uplink drop is not blamed on the router', () => {
  const s = new Sim();
  s.run(2);
  const gw = link('down', { downSince: 2_500 });
  expect(s.run(10, { gw })).toEqual([]);
  expect(s.sm.state).toBe('UP');
  expect(s.sig.gwNoIcmp).toBe(true);
  const drop = { gw, inet: link('down', { downSince: 12_020 }) };
  s.step(drop);
  expect(s.sig.gwNoIcmp).toBe(true); // sticky while the gateway stream stays down
  expect(s.step(drop)).toMatchObject({ to: 'DOWN', cause: 'uplink', startedAtMono: 12_020 });
});

test('a simultaneous Wi-Fi/router loss is not read as a no-ICMP gateway when the streams flip a tick apart', () => {
  const s = new Sim();
  s.run(2);
  s.run(10); // t=3..12 healthy
  // both streams stop answering at ~10 s; the gateway's third timeout lands one tick earlier
  const gw = link('down', { downSince: 10_100 });
  expect(s.step({ gw })).toBeNull(); // t=13
  expect(s.sig.gwNoIcmp).toBe(true); // §6.1 raw formula: gateway down while the internet answers
  const both = { gw, inet: link('down', { downSince: 10_400 }), wifi: wifi(-90, 'yes', 9_000) };
  expect(s.step(both)).toBeNull(); // t=14: the latch never held long enough to be trusted
  expect(s.sig.gwNoIcmp).toBe(false);
  expect(s.step(both)).toMatchObject({ to: 'DOWN', cause: 'wifi', startedAtMono: 10_100 });
});

test('ICMP-filtered network: grace avoids a false DOWN, latch after 30 s, cleared by a received sample', () => {
  const s = new Sim();
  s.run(2);
  let captive = [http('ok', 8_000)];
  s.run(10, { captive }); // t=3..12
  const down = link('down', { downSince: 10_020 });
  expect(s.step({ inet: down, captive })).toBeNull(); // t=13: flip → grace
  expect(s.sig.grace).toBe(true);
  expect(s.sig.graceUntil).toBe(18_000);
  captive = [http('ok', 8_000), http('ok', 13_100, { detector: 'google' })]; // out-of-band check answered
  expect(s.step({ inet: down, captive })).toBeNull(); // t=14
  expect(s.sig.grace).toBe(false);
  expect(s.sig.inetOk).toBe(true);
  for (let t = 15; t <= 45; t++) {
    if ((t - 13) % 3 === 0) captive = [...captive.slice(-2), http('ok', t * 1000 - 900, { detector: t % 2 ? 'apple' : 'google' })];
    expect(s.step({ inet: down, captive })).toBeNull();
    expect(s.sm.state).toBe('UP');
    if (t <= 40) expect(s.sig.icmpBlocked).toBe(false);
    else expect(s.sig.icmpBlocked).toBe(true);
  }
  // a captive dnsfail is not a drop while latched; a fail is
  captive = [...captive.slice(-2), http('dnsfail', 45_500)];
  expect(s.step({ inet: down, captive, dnsSysOkAt: null })).toMatchObject({ to: 'DEGRADED', cause: 'dns' });
  expect(s.sig.inetOk).toBe(true);
  captive = [...captive.slice(-2), http('fail', 46_500)];
  s.step({ inet: down, captive });
  expect(s.sig.inetOk).toBe(false);
  expect(s.step({ inet: down, captive })).toMatchObject({ to: 'DOWN', cause: 'uplink' });
  expect(s.sig.icmpBlocked).toBe(true);
  // any RECEIVED/LATE sample clears the latch
  s.step({ inet: link('down', { downSince: 10_020, lastReceivedAt: 48_500 }), captive });
  expect(s.sig.icmpBlocked).toBe(false);
});

test('grace ends early when the out-of-band check fails; expires after 5 s without an answer', () => {
  const s = new Sim();
  s.run(2);
  let captive = [http('ok', 8_000)];
  s.run(10, { captive });
  const down = link('down', { downSince: 10_020 });
  s.step({ inet: down, captive }); // t=13 grace
  captive = [http('ok', 8_000), http('fail', 13_100)];
  expect(s.step({ inet: down, captive })).toBeNull(); // t=14: grace over, DOWN count 1
  expect(s.sig.grace).toBe(false);
  expect(s.step({ inet: down, captive })).toMatchObject({ to: 'DOWN', cause: 'uplink', at: 15_000, startedAtMono: 10_020 });

  const s2 = new Sim();
  s2.run(2);
  s2.run(10, { captive: [http('ok', 8_000)] });
  for (let t = 13; t <= 17; t++) {
    expect(s2.step({ inet: down, captive: [http('ok', 8_000)] })).toBeNull();
    expect(s2.sig.grace).toBe(true);
  }
  expect(s2.step({ inet: down, captive: [http('ok', 8_000)] })).toBeNull(); // t=18: expired
  expect(s2.sig.grace).toBe(false);
  expect(s2.step({ inet: down, captive: [http('ok', 8_000)] })).toMatchObject({ to: 'DOWN', at: 19_000 });
});

test('NO_LINK causes and backdating to the failing route probe; recovery backdated to the route probe', () => {
  const cases: [Parameters<Sim['step']>[0], string][] = [
    [{ route: route({ hasRoute: false, at: 2_700 }), wifi: wifi(null, 'no', 1_000) }, 'not-joined'],
    [{ route: route({ hasRoute: false, at: 2_700 }), wifi: wifi(-70, 'yes', 1_000) }, 'no-dhcp'],
    [{ route: route({ hasRoute: false, at: 2_700, selfAssigned: true }) }, 'no-dhcp'],
    [{ route: route({ hasRoute: false, at: 2_700 }) }, 'unknown'],
  ];
  for (const [over, cause] of cases) {
    const s = new Sim();
    s.run(2);
    expect(s.step(over)).toMatchObject({ to: 'NO_LINK', cause, at: 3_000, startedAtMono: 2_700 });
  }
  const s = new Sim();
  s.run(2);
  s.step({ route: route({ hasRoute: false, at: 2_700 }) });
  expect(s.step({ route: route({ at: 3_300 }) })).toBeNull();
  expect(s.step({ route: route({ at: 3_300 }) })).toMatchObject({ from: 'NO_LINK', to: 'UP', startedAtMono: 3_300 });
});

test('dnsfail is not DOWN evidence: DEGRADED(dns), and dnsDisabled treats DNS as ok', () => {
  const s = new Sim();
  s.run(2);
  expect(s.step({ captive: [http('dnsfail', 2_500)], dnsSysOkAt: null })).toMatchObject({ to: 'DEGRADED', cause: 'dns' });
  const s2 = new Sim();
  s2.run(2);
  expect(s2.step({ dnsSysOkAt: null, dnsDirectOkAt: null })).toMatchObject({ to: 'DEGRADED', cause: 'dns' });
  const s3 = new Sim();
  s3.run(2);
  expect(s3.run(3, { dnsSysOkAt: null, dnsDirectOkAt: null, dnsDisabled: true })).toEqual([]);
  expect(s3.sm.state).toBe('UP');
});

test('DEGRADED web / quality, silent cause refresh inside DEGRADED, and UP needs 2 ticks', () => {
  const s = new Sim();
  s.run(2);
  expect(s.step({ webFailStreak: 3, captive: [http('fail', 2_500)] })).toMatchObject({ to: 'DEGRADED', cause: 'web' });
  expect(s.step({ heldGrade: 'C' })).toBeNull();
  expect(s.sm.cause).toBe('quality');
  expect(s.step({ heldGrade: 'B' })).toBeNull();
  expect(s.step({ heldGrade: 'B' })).toMatchObject({ from: 'DEGRADED', to: 'UP', cause: null });
});

test('sleep gap: onGap → WARMUP backdated to the gap start, pending reset, then UP again', () => {
  const s = new Sim();
  s.run(2);
  s.step({ inet: link('down', { downSince: 2_020 }) }); // pending DOWN (1 of 2)
  const t = s.sm.onGap(3_000, 1_200_000, WALL0 + 1_200_000);
  expect(t).toMatchObject({ from: 'UP', to: 'WARMUP', cause: null, at: 1_200_000, startedAtMono: 3_000, startedAt: WALL0 + 3_000 });
  expect(s.sm.state).toBe('WARMUP');
  expect(s.sm.since).toBe(1_200_000);
  s.now = 1_200_000;
  expect(s.step({ inet: link('unknown'), gw: link('unknown'), gapMs: 1_197_000 })).toBeNull();
  expect(s.sm.state).toBe('WARMUP');
  s.step({ inet: link('down', { downSince: 1_200_020 }) }); // the pending DOWN was discarded: this is count 1 again
  expect(s.sm.state).toBe('WARMUP');
  expect(s.step()).toBeNull();
  expect(s.step()?.to).toBe('UP');
  expect(s.sm.onGap(1_204_000, 1_300_000)).toMatchObject({ to: 'WARMUP' });
  expect(s.sm.onGap(1_300_000, 1_400_000)).toBeNull(); // already WARMUP
});
