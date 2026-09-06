import { test, expect } from 'bun:test';
import { BIN, WIFI_BACKOFF_MS, WIFI_CADENCE_MS, WIFI_KILL_MS } from '../src/config';
import type { Timed, WifiInfo } from '../src/probes/types';
import type { RunFn, RunResult } from '../src/probes/runner';
import { parseAirportJson, snrLabel, AIRPORT_ARGV, WifiPoller } from '../src/probes/wifi';

const fx = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const basic = await fx('airport-basic.json');
const notConnected = await fx('airport-not-connected.json');

const empty = (iface: string): WifiInfo => ({
  iface, assoc: 'no', ssid: null, rssi: null, noise: null, snr: null, label: null, txRate: null, mcs: null, channel: null, phy: null,
});

// ---- parseAirportJson (§4.6)
test('en1 + awdl0 fixture selects en1 with signal fields', () => {
  expect(parseAirportJson(basic, 'en1')).toEqual({
    iface: 'en1', assoc: 'yes', ssid: null, rssi: -71, noise: -94, snr: 23, label: 'fair',
    txRate: 108, mcs: 4, channel: '157 (5GHz, 80MHz)', phy: '802.11ax',
  });
});
test('awdl0 block (no status, no signal) → assoc no, nulls', () => {
  expect(parseAirportJson(basic, 'awdl0')).toEqual(empty('awdl0'));
});
test('<redacted> SSID → null; a real SSID is kept', () => {
  expect(parseAirportJson(basic, 'en1')?.ssid).toBeNull();
  expect(parseAirportJson(basic.replace('"<redacted>"', '"TestNet"'), 'en1')?.ssid).toBe('TestNet');
});
test('not connected → assoc no with null fields', () => {
  expect(parseAirportJson(notConnected, 'en1')).toEqual(empty('en1'));
});
test('missing interface → null', () => {
  expect(parseAirportJson(basic, 'en0')).toBeNull();
  expect(parseAirportJson(notConnected, 'en0')).toBeNull();
});
test('invalid or unexpected JSON → null, never throws', () => {
  expect(parseAirportJson('', 'en1')).toBeNull();
  expect(parseAirportJson('not json', 'en1')).toBeNull();
  expect(parseAirportJson('{}', 'en1')).toBeNull();
  expect(parseAirportJson('{"SPAirPortDataType":[]}', 'en1')).toBeNull();
  expect(parseAirportJson('{"SPAirPortDataType":[{"spairport_airport_interfaces":"x"}]}', 'en1')).toBeNull();
  expect(parseAirportJson('[1,2]', 'en1')).toBeNull();
});
test('snr labels: good ≥ 25, fair 15–24, poor < 15', () => {
  expect(snrLabel(25)).toBe('good');
  expect(snrLabel(24)).toBe('fair');
  expect(snrLabel(15)).toBe('fair');
  expect(snrLabel(14)).toBe('poor');
  const mk = (sn: string) => JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{
    _name: 'en1', spairport_status_information: 'spairport_status_connected',
    spairport_current_network_information: { _name: 'X', spairport_signal_noise: sn, spairport_network_rate: '216', spairport_network_mcs: 'n/a' },
  }] }] });
  expect(parseAirportJson(mk('-60 dBm / -95 dBm'), 'en1')).toMatchObject({ assoc: 'yes', ssid: 'X', snr: 35, label: 'good', txRate: 216, mcs: null, channel: null, phy: null });
  expect(parseAirportJson(mk('-85 dBm / -75 dBm'), 'en1')).toMatchObject({ rssi: -85, noise: -75, snr: -10, label: 'poor' });
  expect(parseAirportJson(mk('garbage'), 'en1')).toMatchObject({ rssi: null, noise: null, snr: null, label: null });
});

// ---- WifiPoller with injected run()
const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', ms: 13000, timedOut: false });
const killed: RunResult = { ok: false, code: null, stdout: '', stderr: '', ms: 25000, timedOut: true };

function harness(initial: RunResult) {
  let res = initial;
  const calls: { argv: string[]; t: number }[] = [];
  const got: Timed<WifiInfo>[] = [];
  const run: RunFn = async (argv, t) => { calls.push({ argv, t }); return res; };
  const p = new WifiPoller({ run, now: () => 5000 });
  p.start('en1', (i) => got.push(i));
  p.stop(); // drive with pollOnce()
  return { p, calls, got, set: (r: RunResult) => { res = r; } };
}

test('WifiPoller: argv (with -nospawn), kill timeout, Timed<WifiInfo>', async () => {
  const h = harness(ok(basic));
  const info = await h.p.pollOnce();
  // -nospawn keeps system_profiler in one process: without it the tool forks a helper that
  // outlives run()'s SIGTERM/SIGKILL and killAll() (reparented to launchd).
  expect(h.calls[0]?.argv).toEqual([BIN.system_profiler, '-nospawn', '-json', 'SPAirPortDataType', '-detailLevel', 'basic']);
  expect(h.calls[0]?.argv).toEqual([...AIRPORT_ARGV]);
  expect(h.calls[0]?.t).toBe(WIFI_KILL_MS);
  expect(info).toMatchObject({ iface: 'en1', assoc: 'yes', rssi: -71, at: 5000 });
  expect(h.p.last).toEqual(info);
  expect(h.got.length).toBe(0); // stopped poller does not emit
});

test('WifiPoller: the reading is stamped when system_profiler finishes, not at launch (§4.6)', async () => {
  let t = 1000;
  const run: RunFn = async () => { t += 13000; return ok(basic); }; // ≈13 s wall
  const p = new WifiPoller({ run, now: () => t });
  p.start('en1', () => {});
  p.stop();
  const info = await p.pollOnce();
  expect(info?.at).toBe(14000); // completion, so the WI-FI cell age starts at 0 s
  expect(p.last?.at).toBe(14000);
});

test('WifiPoller: 3 consecutive failures → 120 s cadence; success resets', async () => {
  const h = harness(killed);
  expect(h.p.cadenceMs).toBe(WIFI_CADENCE_MS);
  for (let i = 0; i < 2; i++) expect(await h.p.pollOnce()).toBeNull();
  expect(h.p.cadenceMs).toBe(WIFI_CADENCE_MS);
  expect(await h.p.pollOnce()).toBeNull();
  expect(h.p.failures).toBe(3);
  expect(h.p.cadenceMs).toBe(WIFI_BACKOFF_MS);
  h.set(ok('{"SPAirPortDataType":[{"spairport_airport_interfaces":[]}]}')); // parse null counts as failure
  await h.p.pollOnce();
  expect(h.p.failures).toBe(4);
  h.set(ok(basic));
  expect(await h.p.pollOnce()).not.toBeNull();
  expect(h.p.failures).toBe(0);
  expect(h.p.cadenceMs).toBe(WIFI_CADENCE_MS);
});

test('WifiPoller: no iface → no run; setIface pauses/resumes and discards a stale in-flight result', async () => {
  const h = harness(ok(basic));
  h.p.setIface(null);
  expect(await h.p.pollOnce()).toBeNull();
  expect(h.calls.length).toBe(0);
  h.p.setIface('en1');
  const pending = h.p.pollOnce();
  h.p.setIface('en0'); // retargeted while system_profiler is running
  expect(await pending).toBeNull();
  expect(h.p.last).toBeNull();
});

test('WifiPoller: start(iface) polls immediately on the timer chain and emits', async () => {
  const got: Timed<WifiInfo>[] = [];
  const p = new WifiPoller({ run: async () => ok(basic) });
  p.start(null, (i) => got.push(i));
  await Bun.sleep(20);
  expect(got.length).toBe(0);
  p.setIface('en1');
  await Bun.sleep(20);
  expect(got.length).toBe(1);
  expect(got[0]?.rssi).toBe(-71);
  expect(typeof got[0]?.at).toBe('number');
  p.stop();
});
