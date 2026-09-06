import { test, expect } from 'bun:test';
import { pickTip } from '../src/model/tips';
import { GLYPHS } from '../src/ui/ansi';
import { makeSnapshot, makeGrade, makeWifi, makeDns, makeRoute, makeOutage, wallAt, NO_DROPS } from './helpers/snapshot';

const tip = (s: Parameters<typeof makeSnapshot>[0]) => pickTip(makeSnapshot(s));

test('no tip on a healthy default', () => {
  expect(tip({ dnsSys: makeDns({ ms: 40, server: '100.100.100.100' }) })).toBeNull();
});

test('PORTAL wins over everything', () => {
  expect(tip({ state: 'PORTAL', cause: 'portal', icmpBlocked: true, wifi: makeWifi({ rssi: -90 }) })).toBe('press o to open the login page');
});

test('NO_LINK no-dhcp beats weak signal; other NO_LINK causes do not', () => {
  const s = tip({ state: 'NO_LINK', cause: 'no-dhcp', wifi: makeWifi({ rssi: -90 }) });
  expect(s).toBe('no address from the router yet (DHCP) — wait ~30s, then re-join Wi-Fi');
  expect(tip({ state: 'NO_LINK', cause: 'not-joined', wifi: makeWifi({ rssi: -90 }) })).toBe('weak signal -90 dBm — move closer to the access point');
});

test('weak signal needs rssi < -80 and a fresh reading', () => {
  expect(tip({ wifi: makeWifi({ rssi: -84 }), dnsSys: makeDns() })).toBe('weak signal -84 dBm — move closer to the access point');
  expect(tip({ wifi: makeWifi({ rssi: -80 }), dnsSys: makeDns() })).toBeNull();
  expect(tip({ wifi: makeWifi({ rssi: -84 }), wifiStatus: 'stale', dnsSys: makeDns() })).toBeNull();
});

test('icmpBlocked > gwNoIcmp', () => {
  expect(tip({ icmpBlocked: true, gwNoIcmp: true })).toBe('network blocks ping — judging by HTTP checks, latency is coarse');
  expect(tip({ gwNoIcmp: true })).toBe('router ignores ping — local link judged by internet checks');
});

test('Tailscale DNS slow: ratio ≥ 4 and sys > 200 ms', () => {
  expect(tip({})).toBe('Tailscale DNS is 12x slower than direct (380 vs 31ms) — pages feel slow; consider pausing it.');
  expect(tip({ dnsSys: makeDns({ ms: 120, server: '100.100.100.100' }) })).toBeNull(); // ratio ok, under 200
  expect(tip({ dnsSys: makeDns({ ms: 250, server: '100.100.100.100' }), dnsDirect: makeDns({ ms: 100 }) })).toBeNull(); // ratio 2.5
  expect(tip({ dnsServer: '192.168.0.1', dnsSys: makeDns({ ms: 380, server: '192.168.0.1' }) }))
    .toBe('system DNS is 12x slower than direct (380 vs 31ms) — pages feel slow.');
  expect(tip({ dnsSys: makeDns({ ms: 380, ok: false }), dnsSysOk: false, dnsDirectOk: true }))
    .toBe('system DNS (Tailscale 100.100.100.100) failing; direct DNS works — Tailscale, not the network');
});

test('system DNS failing while direct works', () => {
  expect(tip({ dnsSysOk: false, dnsDirectOk: true, dnsSys: makeDns({ ok: false, ms: null }) }))
    .toBe('system DNS (Tailscale 100.100.100.100) failing; direct DNS works — Tailscale, not the network');
  expect(tip({ dnsSysOk: false, dnsDirectOk: true, dnsServer: '10.0.0.1', dnsSys: makeDns({ ok: false, ms: null }) }))
    .toBe('system DNS (10.0.0.1) failing; direct DNS works — the resolver, not the network');
  expect(tip({ dnsSysOk: false, dnsDirectOk: false, dnsOk: false, dnsSys: makeDns({ ok: false, ms: null }) })).toBeNull();
});

test('vpn tip names the egress interface', () => {
  const s = { vpn: true, route: makeRoute({ vpn: true, egressIface: 'utun9' }), dnsSys: makeDns({ ms: 40, server: '100.100.100.100' }) };
  expect(tip(s)).toBe('traffic exits via utun9 (Tailscale exit node) — measurements go through the tunnel');
  expect(tip({ ...s, dnsServer: '10.0.0.1' })).toBe('traffic exits via utun9 (VPN) — measurements go through the tunnel');
});

test('portal cycle: ≥ 2 portal outages in 30 min', () => {
  const outages = [
    makeOutage({ n: 3, state: 'PORTAL', cause: 'portal', startedAt: wallAt('14:25:00'), durationS: 40 }),
    makeOutage({ n: 2, state: 'DOWN', cause: 'uplink', startedAt: wallAt('14:20:00'), durationS: 10 }),
    makeOutage({ n: 1, state: 'PORTAL', cause: 'portal', startedAt: wallAt('14:13:00'), durationS: 50 }),
  ];
  const quietDns = makeDns({ ms: 40, server: '100.100.100.100' });
  expect(tip({ outages, dnsSys: quietDns })).toBe('portal logs you out every ~12m — keep the login tab open');
  // one of them older than 30 min → only one counts
  const old = [outages[0]!, makeOutage({ n: 1, state: 'PORTAL', cause: 'portal', startedAt: wallAt('13:50:00') })];
  expect(tip({ outages: old, dnsSys: quietDns })).toBeNull();
  // sleep-closed outages are ignored
  const slept = [outages[0]!, makeOutage({ ...outages[2]!, sleep: true })];
  expect(tip({ outages: slept, dnsSys: quietDns })).toBeNull();
});

test('sat and under-load tips; priority sat > load', () => {
  const quiet = { dnsSys: makeDns({ ms: 40, server: '100.100.100.100' }), outages: [], drops: NO_DROPS };
  expect(tip({ ...quiet, sat: true, rttOffset: 600, grade: makeGrade({ underLoad: true }) }))
    .toBe('satellite link: ~700ms is normal here; thresholds adjusted');
  expect(tip({ ...quiet, grade: makeGrade({ underLoad: true }) })).toBe('your own traffic is loading the link — numbers marked ~');
});

test('ascii glyphs swap the dash', () => {
  expect(pickTip(makeSnapshot({ icmpBlocked: true }), GLYPHS.ascii)).toBe('network blocks ping - judging by HTTP checks, latency is coarse');
});
