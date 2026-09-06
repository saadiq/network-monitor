import { test, expect } from 'bun:test';
import { BIN, ROUTE_CADENCE_MS, ROUTE_FAST_CADENCE_MS } from '../src/config';
import type { RouteInfo } from '../src/probes/types';
import type { RunFn, RunResult } from '../src/probes/runner';
import {
  parseRouteGet, parseNwiAddress, parseHardwarePorts, wifiIfaceFromPorts, parseIpconfigRouter, RoutePoller,
} from '../src/probes/route';

const fx = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const routeOk = await fx('route-get-1.1.1.1.txt');
const routeDefault = await fx('route-get-10.255.255.1.txt');
const routeUtun = await fx('route-get-utun.txt');
const routeNone = await fx('route-get-not-in-table.txt');
const nwi = await fx('scutil-nwi.txt');
const nwiSelf = await fx('scutil-nwi-selfassigned.txt');
const nwiNone = await fx('scutil-nwi-none.txt');
const nwiTwo = await fx('scutil-nwi-two-ifaces.txt');
const ports = await fx('networksetup-hardwareports.txt');
const ipconfig = await fx('ipconfig-router-en1.txt');

// ---- parseRouteGet (§4.1.1)
test('parseRouteGet: host route to 1.1.1.1 via en1', () => {
  expect(parseRouteGet(routeOk)).toEqual({ hasRoute: true, gateway: '192.168.0.1', egressIface: 'en1' });
});
test('parseRouteGet: default-route answer for an unknown host', () => {
  expect(parseRouteGet(routeDefault)).toEqual({ hasRoute: true, gateway: '192.168.0.1', egressIface: 'en1' });
});
test('parseRouteGet: utun egress with a link# gateway', () => {
  expect(parseRouteGet(routeUtun)).toEqual({ hasRoute: true, gateway: 'link#30', egressIface: 'utun9' });
});
test('parseRouteGet: not in table / empty → no route', () => {
  expect(parseRouteGet(routeNone)).toEqual({ hasRoute: false, gateway: null, egressIface: null });
  expect(parseRouteGet('')).toEqual({ hasRoute: false, gateway: null, egressIface: null });
});
test('parseRouteGet: interface without gateway (directly connected)', () => {
  expect(parseRouteGet('   route to: 192.168.0.5\n  interface: en1\n')).toEqual({ hasRoute: true, gateway: null, egressIface: 'en1' });
});

// ---- parseNwiAddress (§4.1.3)
test('parseNwiAddress: en1 address from the real fixture', () => {
  expect(parseNwiAddress(nwi, 'en1')).toBe('192.168.0.65');
});
test('parseNwiAddress: 169.254 self-assigned address', () => {
  expect(parseNwiAddress(nwiSelf, 'en1')).toBe('169.254.17.42');
});
test('parseNwiAddress: no IPv4 states → null', () => {
  expect(parseNwiAddress(nwiNone, 'en1')).toBeNull();
  expect(parseNwiAddress('', 'en1')).toBeNull();
});
test('parseNwiAddress: selects the right interface and ignores the IPv6 block', () => {
  expect(parseNwiAddress(nwiTwo, 'en1')).toBe('192.168.0.65');
  expect(parseNwiAddress(nwiTwo, 'en0')).toBe('10.0.0.5');
  expect(parseNwiAddress(nwiTwo, 'en2')).toBeNull();
  const v6only = nwiTwo.replace(/     en1 : flags {6}: 0x5 \(IPv4,DNS\)\n {11}address {4}: 192\.168\.0\.65\n {11}reach {6}: 0x00000002 \(Reachable\)\n/, '');
  expect(parseNwiAddress(v6only, 'en1')).toBeNull();
});

// ---- parseHardwarePorts (§4.1.2)
test('parseHardwarePorts: port → device map, Wi-Fi is en1', () => {
  const m = parseHardwarePorts(ports);
  expect(m['Wi-Fi']).toBe('en1');
  expect(m['Ethernet']).toBe('en0');
  expect(m['Thunderbolt Bridge']).toBe('bridge0');
  expect(wifiIfaceFromPorts(m)).toBe('en1');
});
test('wifiIfaceFromPorts: AirPort fallback, none, override-free', () => {
  expect(wifiIfaceFromPorts({ AirPort: 'en0' })).toBe('en0');
  expect(wifiIfaceFromPorts({ Ethernet: 'en0' })).toBeNull();
  expect(parseHardwarePorts('Device: en9\n')).toEqual({});
});

// ---- parseIpconfigRouter (§4.1.4)
test('parseIpconfigRouter: dotted quad only', () => {
  expect(parseIpconfigRouter(ipconfig)).toBe('192.168.0.1');
  expect(parseIpconfigRouter(' 10.0.0.1\n')).toBe('10.0.0.1');
  expect(parseIpconfigRouter('')).toBeNull();
  expect(parseIpconfigRouter('ipconfig: could not get router\n')).toBeNull();
  expect(parseIpconfigRouter('fe80::1\n')).toBeNull();
});

// ---- RoutePoller with an injected run()
const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', ms: 1, timedOut: false });
const fail = (stderr: string, code = 1): RunResult => ({ ok: false, code, stdout: '', stderr, ms: 1, timedOut: false });

function fake(map: Partial<Record<string, RunResult>>): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = async (argv) => {
    calls.push(argv);
    return map[argv[0] ?? ''] ?? fail('unexpected binary', 127);
  };
  return { run, calls };
}

test('RoutePoller: plain Wi-Fi egress; networksetup once per egress', async () => {
  const { run, calls } = fake({ [BIN.route]: ok(routeOk), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi) });
  const p = new RoutePoller({ run, target: '1.1.1.1' });
  const info = await p.pollOnce();
  expect(info).toMatchObject({
    hasRoute: true, egressIface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', pingGateway: '192.168.0.1',
    ipv4: '192.168.0.65', selfAssigned: false, vpn: false,
  });
  expect(typeof info.at).toBe('number');
  expect(calls.map((a) => a[0])).toEqual([BIN.route, BIN.networksetup, BIN.scutil]);
  expect(calls[0]).toEqual([BIN.route, '-n', 'get', '1.1.1.1']);
  await p.pollOnce();
  expect(calls.filter((a) => a[0] === BIN.networksetup).length).toBe(1);
  expect(calls.some((a) => a[0] === BIN.ipconfig)).toBe(false);
  const again = await p.pollOnce();
  expect(p.last).toBe(again);
});

test('RoutePoller: VPN egress → vpn=true, pingGateway from ipconfig router', async () => {
  const { run, calls } = fake({ [BIN.route]: ok(routeUtun), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi), [BIN.ipconfig]: ok(ipconfig) });
  const info = await new RoutePoller({ run }).pollOnce();
  expect(info).toMatchObject({ hasRoute: true, egressIface: 'utun9', wifiIface: 'en1', gateway: 'link#30', pingGateway: '192.168.0.1', vpn: true, ipv4: '192.168.0.65' });
  expect(calls.find((a) => a[0] === BIN.ipconfig)).toEqual([BIN.ipconfig, 'getoption', 'en1', 'router']);
});

test('RoutePoller: VPN without a DHCP router → pingGateway null', async () => {
  const { run } = fake({ [BIN.route]: ok(routeUtun), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi), [BIN.ipconfig]: ok('') });
  const info = await new RoutePoller({ run }).pollOnce();
  expect(info.vpn).toBe(true);
  expect(info.pingGateway).toBeNull();
});

test('RoutePoller: non-dotted gateway without VPN → pingGateway null', async () => {
  const s = routeOk.replace('gateway: 192.168.0.1', 'gateway: link#16');
  const { run } = fake({ [BIN.route]: ok(s), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi) });
  const info = await new RoutePoller({ run }).pollOnce();
  expect(info).toMatchObject({ hasRoute: true, gateway: 'link#16', pingGateway: null, vpn: false });
});

test('RoutePoller: no route → hasRoute false; selfAssigned still read from scutil', async () => {
  const { run } = fake({ [BIN.route]: fail(routeNone), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwiSelf) });
  const info = await new RoutePoller({ run }).pollOnce();
  expect(info).toMatchObject({
    hasRoute: false, egressIface: null, gateway: null, pingGateway: null, wifiIface: 'en1',
    ipv4: '169.254.17.42', selfAssigned: true, vpn: false,
  });
});

test('RoutePoller: non-zero exit is no route even with parseable stdout', async () => {
  const { run } = fake({ [BIN.route]: { ...ok(routeOk), ok: false, code: 1 }, [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi) });
  const info = await new RoutePoller({ run }).pollOnce();
  expect(info.hasRoute).toBe(false);
  expect(info.egressIface).toBeNull();
});

test('RoutePoller: --iface override skips networksetup', async () => {
  const { run, calls } = fake({ [BIN.route]: ok(routeOk), [BIN.scutil]: ok(nwi) });
  const info = await new RoutePoller({ run, iface: 'en1' }).pollOnce();
  expect(info.wifiIface).toBe('en1');
  expect(calls.some((a) => a[0] === BIN.networksetup)).toBe(false);
});

test('RoutePoller: networksetup re-runs when egress changes or after a failure', async () => {
  let route = routeOk;
  let portsRes = fail('boom');
  const calls: string[][] = [];
  const run: RunFn = async (argv) => {
    calls.push(argv);
    switch (argv[0]) {
      case BIN.route: return ok(route);
      case BIN.networksetup: return portsRes;
      case BIN.scutil: return ok(nwi);
      case BIN.ipconfig: return ok(ipconfig);
      default: return fail('x');
    }
  };
  const p = new RoutePoller({ run });
  expect((await p.pollOnce()).wifiIface).toBeNull(); // lookup failed → retried next poll
  portsRes = ok(ports);
  expect((await p.pollOnce()).wifiIface).toBe('en1');
  await p.pollOnce();
  route = routeUtun;
  await p.pollOnce();
  expect(calls.filter((a) => a[0] === BIN.networksetup).length).toBe(3);
});

test('RoutePoller: start emits on every poll, setFast switches cadence, stop halts', async () => {
  const { run } = fake({ [BIN.route]: ok(routeOk), [BIN.networksetup]: ok(ports), [BIN.scutil]: ok(nwi) });
  const p = new RoutePoller({ run });
  const got: RouteInfo[] = [];
  expect(p.cadenceMs).toBe(ROUTE_CADENCE_MS);
  p.setFast(true);
  expect(p.cadenceMs).toBe(ROUTE_FAST_CADENCE_MS);
  p.start((i) => got.push(i));
  await Bun.sleep(30);
  expect(got.length).toBe(1);
  expect(got[0]?.egressIface).toBe('en1');
  p.setFast(false);
  expect(p.cadenceMs).toBe(ROUTE_CADENCE_MS);
  p.stop();
  await Bun.sleep(10);
  expect(got.length).toBe(1);
});
