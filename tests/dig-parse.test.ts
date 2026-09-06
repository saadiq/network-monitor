import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildDigArgs, parseDig, digResult, nextName, directServer, DnsPoller } from '../src/probes/dns';
import { fakeResult, type RunFn } from '../src/probes/run-types';
import { BIN, DNS_DIRECT_SERVER, DNS_PROCESS_TIMEOUT_MS } from '../src/config';

const fx = (name: string) => readFileSync(`${import.meta.dir}/fixtures/${name}`, 'utf8');
const noerror = fx('dig-noerror.txt');
const nxdomain = fx('dig-nxdomain.txt');
const nodata = fx('dig-cachebuster-nodata.txt');
const timeout = fx('dig-timeout.txt');
const servfail = noerror.replace('status: NOERROR', 'status: SERVFAIL');
const refused = noerror.replace('status: NOERROR', 'status: REFUSED');

test('buildDigArgs matches §4.5 (system path and @1.1.1.1)', () => {
  expect(buildDigArgs('www.apple.com')).toEqual([
    BIN.dig, '+time=2', '+tries=1', '+noall', '+comments', '+stats', 'www.apple.com', 'A',
  ]);
  expect(buildDigArgs('www.apple.com', '1.1.1.1')).toEqual([
    BIN.dig, '+time=2', '+tries=1', '+noall', '+comments', '+stats', 'www.apple.com', 'A', '@1.1.1.1',
  ]);
});

test('parseDig NOERROR: ok, Query time and SERVER extracted', () => {
  expect(parseDig(noerror, 0)).toEqual({ ok: true, ms: 10, server: '100.100.100.100', status: 'NOERROR', err: null });
});

test('parseDig NXDOMAIN is ok (recursion works)', () => {
  expect(parseDig(nxdomain, 0)).toEqual({ ok: true, ms: 13, server: '1.1.1.1', status: 'NXDOMAIN', err: null });
  expect(parseDig(nodata, 0).ok).toBe(true); // example.com answers NOERROR/NODATA for random labels
});

test('parseDig SERVFAIL / REFUSED → DNS_ERROR', () => {
  expect(parseDig(servfail, 0)).toEqual({ ok: false, ms: 10, server: '100.100.100.100', status: 'SERVFAIL', err: 'DNS_ERROR' });
  const r = parseDig(refused, 0);
  expect(r.ok).toBe(false);
  expect(r.err).toBe('DNS_ERROR');
  expect(r.status).toBe('REFUSED');
});

test('parseDig timeout: exit 9 or "connection timed out"', () => {
  expect(parseDig(timeout, 9)).toEqual({ ok: false, ms: null, server: null, status: null, err: 'TIMEOUT' });
  expect(parseDig(timeout, 0).err).toBe('TIMEOUT');
  expect(parseDig('', 9).err).toBe('TIMEOUT');
});

test('parseDig: dig itself failing → PROBE_ERROR', () => {
  expect(parseDig('', 1)).toEqual({ ok: false, ms: null, server: null, status: null, err: 'PROBE_ERROR' });
  expect(parseDig('', 0).err).toBe('PROBE_ERROR'); // exit 0 with no status line
  expect(parseDig(noerror, 10).err).toBe('PROBE_ERROR');
});

test('digResult wraps spawn failures and process kills', () => {
  expect(digResult(fakeResult('', null, { err: 'ENOENT' })).err).toBe('PROBE_ERROR');
  expect(digResult(fakeResult('', null, { timedOut: true })).err).toBe('TIMEOUT');
  expect(digResult(fakeResult(noerror, 0))).toEqual(parseDig(noerror, 0));
});

test('nextName rotates three names with a cache-buster every 4th round', () => {
  const names = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => nextName(r));
  expect(names[0]).toBe('www.apple.com');
  expect(names[1]).toBe('www.cloudflare.com');
  expect(names[2]).toBe('www.google.com');
  expect(names[3]).toMatch(/^[0-9a-f]{8}\.example\.com$/);
  expect(names.slice(4, 7)).toEqual(['www.apple.com', 'www.cloudflare.com', 'www.google.com']);
  expect(names[7]).toMatch(/^[0-9a-f]{8}\.example\.com$/);
  expect(names[8]).toBe('www.apple.com');
  expect(nextName(3, 'deadbeef')).toBe('deadbeef.example.com');
  expect(nextName(3)).not.toBe(nextName(7)); // random label
});

test('DnsPoller runs system + direct concurrently and emits a DnsPair', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const run: RunFn = async (argv, timeoutMs) => {
    expect(timeoutMs).toBe(DNS_PROCESS_TIMEOUT_MS);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(5);
    inFlight -= 1;
    const direct = argv.includes('@1.1.1.1');
    return direct ? fakeResult(nxdomain, 0) : fakeResult(timeout, 9);
  };
  const p = new DnsPoller(run, { cadenceMs: 30 });
  const pairs: { name: string; sysErr: string | null; directOk: boolean }[] = [];
  p.start((pair) => pairs.push({ name: pair.name, sysErr: pair.sys.err, directOk: pair.direct.ok }));
  await Bun.sleep(80);
  p.stop();
  const n = pairs.length;
  await Bun.sleep(40);
  expect(pairs.length).toBe(n);
  expect(maxInFlight).toBe(2);
  expect(n).toBeGreaterThanOrEqual(2);
  expect(pairs[0]).toEqual({ name: 'www.apple.com', sysErr: 'TIMEOUT', directOk: true });
  expect(pairs[1]?.name).toBe('www.cloudflare.com');
});

test('DnsPoller: a rejected run becomes PROBE_ERROR, never throws', async () => {
  const run: RunFn = async (argv) => {
    if (argv.includes('@1.1.1.1')) throw new Error('boom');
    return fakeResult(noerror, 0);
  };
  const p = new DnsPoller(run, { cadenceMs: 10000 });
  const got: string[] = [];
  p.start((pair) => got.push(`${pair.sys.ok}/${pair.direct.err}`));
  await Bun.sleep(10);
  p.stop();
  expect(got).toEqual(['true/PROBE_ERROR']);
});

test('NETMON_DNS_SERVER overrides the direct resolver the poller digs against (dev-only)', async () => {
  const prev = process.env['NETMON_DNS_SERVER'];
  const seen: string[][] = [];
  try {
    process.env['NETMON_DNS_SERVER'] = '10.255.255.1';
    expect(directServer()).toBe('10.255.255.1');
    const run: RunFn = async (argv) => { seen.push(argv); return fakeResult(noerror); };
    const p2 = new DnsPoller(run, { cadenceMs: 60_000 });
    p2.start(() => {});
    await Bun.sleep(10);
    p2.stop();
    expect(seen.some((a) => a.includes('@10.255.255.1'))).toBe(true);
    expect(seen.some((a) => a.includes('@1.1.1.1'))).toBe(false);
    process.env['NETMON_DNS_SERVER'] = 'not a server';
    expect(directServer()).toBe(DNS_DIRECT_SERVER); // garbage ignored
  } finally {
    if (prev === undefined) delete process.env['NETMON_DNS_SERVER'];
    else process.env['NETMON_DNS_SERVER'] = prev;
  }
});
