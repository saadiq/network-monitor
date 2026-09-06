// §4.1.5 + §6.2 row 1: which interface the Wi-Fi poller reads, and the NO_LINK cause that
// depends on it. Constructed with every binary "missing" except system_profiler and never
// started, so no child process is ever spawned.
import { test, expect } from 'bun:test';
import { ifaceIgnored, Probes, wifiPollIface } from '../src/app/probes';
import { ALL_BINS, BIN } from '../src/config';
import { Store, type StreamHealth } from '../src/model/store';
import type { ProbeHooks } from '../src/app/probes';
import type { Options } from '../src/cli/types';
import type { RouteInfo, Timed, WifiInfo } from '../src/probes/types';

const WALL = Date.UTC(2026, 8, 6, 14);
const NO_STREAMS: StreamHealth = { inetStalled: true, gwStalled: true, gwActive: false };

const OPTS: Options = {
  target: '1.1.1.1', iface: null, log: null, portalUrl: null,
  plain: false, ascii: false, color: false, bell: false, help: false,
};

const route = (over: Partial<RouteInfo> = {}): RouteInfo => ({
  hasRoute: true, egressIface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1',
  pingGateway: '192.168.0.1', ipv4: '192.168.0.42', selfAssigned: false, vpn: false, at: 0, ...over,
});

const wifi = (assoc: 'yes' | 'no'): Timed<WifiInfo> => ({
  iface: 'en1', assoc, ssid: assoc === 'yes' ? 'TestNet' : null, rssi: assoc === 'yes' ? -71 : null,
  noise: null, snr: null, label: null, txRate: null, mcs: null, channel: null, phy: null, at: 0,
});

/** Probes with only system_profiler present; start() is never called, so nothing spawns. */
function make(opts: Options = OPTS, hooks: ProbeHooks = {}): {
  store: Store; probes: Probes; feedRoute: (i: RouteInfo) => void;
} {
  const store = new Store({ target: '1.1.1.1', now: 0, wall: WALL });
  const missing = new Set(ALL_BINS.filter((b) => b !== BIN.system_profiler));
  const probes = new Probes(store, opts, missing, hooks);
  const feedRoute = (i: RouteInfo): void => (probes as unknown as { handleRoute(i: RouteInfo): void }).handleRoute(i);
  return { store, probes, feedRoute };
}

// ---- the gate itself (§4.1.5) -------------------------------------------------------------

test('wifiPollIface: polls while Wi-Fi is the egress, under a VPN, and while there is no route', () => {
  expect(wifiPollIface(route())).toBe('en1'); // Wi-Fi is the egress
  expect(wifiPollIface(route({ egressIface: 'utun4', vpn: true }))).toBe('en1'); // VPN over Wi-Fi
  // no route at all: the radio is exactly what §6.2 row 1 needs to name the cause
  expect(wifiPollIface(route({ hasRoute: false, egressIface: null, gateway: null, pingGateway: null }))).toBe('en1');
  expect(wifiPollIface(route({ hasRoute: false, egressIface: null, wifiIface: null }))).toBeNull();
  // a live non-Wi-Fi egress (Ethernet): Wi-Fi is not what we are measuring → paused
  expect(wifiPollIface(route({ egressIface: 'en0' }))).toBeNull();
});

// ---- through Probes.handleRoute + Store.tick (§6.2 row 1) -----------------------------------

test('route loss keeps the Wi-Fi reading, so NO_LINK is `not-joined` when the radio is unassociated', () => {
  const { store, probes, feedRoute } = make();
  feedRoute(route());
  expect(store.wifiEnabled).toBe(true);
  store.onWifi(wifi('no'));
  feedRoute(route({ hasRoute: false, egressIface: null, gateway: null, pingGateway: null, ipv4: null }));
  expect(store.wifiEnabled).toBe(true); // the radio is still the thing to look at
  expect((probes.wifi as unknown as { iface: string | null }).iface).toBe('en1'); // polling never interrupted
  const out = store.tick(1000, WALL + 1000, 1000, NO_STREAMS);
  expect(out.snap.state).toBe('NO_LINK');
  expect(out.snap.cause).toBe('not-joined');
  expect(out.snap.signals.assoc).toBe('no');
});

test('joined but no DHCP while the route is gone → NO_LINK(no-dhcp)', () => {
  const { store, feedRoute } = make();
  store.onWifi(wifi('yes'));
  feedRoute(route({ hasRoute: false, egressIface: null, gateway: null, pingGateway: null, ipv4: null }));
  const out = store.tick(1000, WALL + 1000, 1000, NO_STREAMS);
  expect(out.snap.state).toBe('NO_LINK');
  expect(out.snap.cause).toBe('no-dhcp');
  const selfAssigned = make();
  selfAssigned.store.onWifi(wifi('no'));
  selfAssigned.feedRoute(route({ hasRoute: false, egressIface: null, ipv4: '169.254.3.4', selfAssigned: true }));
  const o2 = selfAssigned.store.tick(1000, WALL + 1000, 1000, NO_STREAMS);
  expect(o2.snap.cause).toBe('no-dhcp'); // §6.2: a self-assigned address wins over assoc
});

test('a live non-Wi-Fi egress still pauses Wi-Fi polling and blanks the cell (§4.1.5)', () => {
  const { store, probes, feedRoute } = make();
  feedRoute(route());
  store.onWifi(wifi('yes'));
  feedRoute(route({ egressIface: 'en0', gateway: '10.0.0.1', pingGateway: '10.0.0.1' }));
  expect(store.wifiEnabled).toBe(false);
  expect((probes.wifi as unknown as { iface: string | null }).iface).toBeNull();
  const out = store.tick(1000, WALL + 1000, 1000, NO_STREAMS);
  expect(out.snap.signals.assoc).toBeNull(); // no Wi-Fi facts while Ethernet is the egress
});

// ---- §12: an --iface that is not the egress is announced once ------------------------------

test('ifaceIgnored: only a live non-VPN route out of another interface makes --iface inert', () => {
  expect(ifaceIgnored(route(), 'en1')).toBe(false); // --iface IS the egress
  expect(ifaceIgnored(route({ egressIface: 'en0' }), 'en1')).toBe(true); // Ethernet is the egress
  expect(ifaceIgnored(route({ egressIface: 'utun4', vpn: true }), 'en1')).toBe(false); // VPN over it
  expect(ifaceIgnored(route({ hasRoute: false, egressIface: null }), 'en1')).toBe(false); // no route yet
  expect(ifaceIgnored(route({ egressIface: 'en0' }), null)).toBe(false); // no override to ignore
});

test('the ignored-iface hook fires once, not on every route poll', () => {
  const seen: Array<[string, string | null]> = [];
  const opts: Options = { ...OPTS, iface: 'en1' };
  const { feedRoute } = make(opts, { onIfaceIgnored: (i, e) => void seen.push([i, e]) });
  feedRoute(route({ egressIface: 'en0', gateway: '10.0.0.1', pingGateway: '10.0.0.1' }));
  feedRoute(route({ egressIface: 'en0', gateway: '10.0.0.1', pingGateway: '10.0.0.1' }));
  expect(seen).toEqual([['en1', 'en0']]);
});

test('the ignored-iface hook stays silent while --iface is the egress', () => {
  const seen: string[] = [];
  const opts: Options = { ...OPTS, iface: 'en1' };
  const { feedRoute } = make(opts, { onIfaceIgnored: (i) => void seen.push(i) });
  feedRoute(route());
  feedRoute(route({ hasRoute: false, egressIface: null }));
  feedRoute(route({ egressIface: 'utun4', vpn: true }));
  expect(seen).toEqual([]);
});
