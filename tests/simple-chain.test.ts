import { test, expect } from 'bun:test';
import { chain } from '../src/ui/sections/chain';
import { glyphs, strip } from '../src/ui/ansi';
import { visibleWidth } from '../src/core/format';
import { BIN } from '../src/config';
import { makeHttp, makeRoute, makeSignals, makeSnapshot, NOW } from './helpers/snapshot';

const G = glyphs(false);
const A = glyphs(true);
const ASCII_RE = /^[\x00-\x7f]*$/;

const downSnap = () => makeSnapshot({
  state: 'DOWN', cause: 'uplink',
  signals: makeSignals({ inetLink: 'down', inetOk: false, inetDownSince: NOW - 42000 }),
  dnsDirectOk: false, dnsSysOk: false, dnsOk: false,
  http: makeHttp({ kind: 'fail', exitCode: 7, code: null }),
});

test('80 cols, color off: mark glyphs instead of dots, full connectors', () => {
  const [row] = chain(makeSnapshot(), 80, G, false);
  expect(visibleWidth(row ?? '')).toBe(80);
  expect(row?.trimEnd()).toBe('  Wi-Fi ✔──── Router ✔──── Internet ✔──── DNS ✔──── Web ✔');
});

test('color on: green dots, dim connectors', () => {
  const [row] = chain(makeSnapshot(), 80, G, true);
  expect(row?.split('\x1b[32m●\x1b[39m').length).toBe(6);
  expect(row).toContain('\x1b[2m──── \x1b[22m');
});

test('the first failing hop shows its detail; later failures only their dot', () => {
  const [row] = chain(downSnap(), 100, G, false);
  expect(row?.trimEnd()).toBe('  Wi-Fi ✔──── Router ✔──── Internet ✘ no reply 42s ──── DNS ✘──── Web ✘');
});

test('width ladder: 40 cols drops connector spaces and abbreviates Internet', () => {
  const [row] = chain(makeSnapshot(), 40, G, true);
  expect(strip(row ?? '').trimEnd()).toBe('  Wi-Fi ●─Router ●─Inet ●─DNS ●─Web ●');
  for (let w = 40; w <= 120; w++) expect(visibleWidth(chain(downSnap(), w, G, true)[0] ?? '')).toBe(w);
});

test('Ethernet with no pingable gateway: only Internet, DNS, Web', () => {
  const snap = makeSnapshot({ wifiStatus: 'off', route: makeRoute({ pingGateway: null }) });
  expect(chain(snap, 80, G, false)[0]?.trimEnd()).toBe('  Internet ✔──── DNS ✔──── Web ✔');
});

test('portal: magenta dot and detail on the Web hop', () => {
  const [row] = chain(makeSnapshot({ state: 'PORTAL', http: makeHttp({ kind: 'portal' }) }), 80, G, true);
  expect(row).toContain('\x1b[35m●\x1b[39m');
  expect(row).toContain('\x1b[35mportal\x1b[39m');
});

test('ascii, color off: OK marks and dashes, pure ASCII', () => {
  const [row] = chain(makeSnapshot(), 80, A, false);
  expect(row?.trimEnd()).toBe('  Wi-Fi OK---- Router OK---- Internet OK---- DNS OK---- Web OK');
  expect(ASCII_RE.test(row ?? '')).toBe(true);
});

test('too narrow even for the last rung: whole hops only, never a cut mark', () => {
  const [row] = chain(makeSnapshot(), 40, A, false);
  expect(row?.trimEnd()).toBe('  Wi-Fi OK-Router OK-Inet OK-DNS OK');
});

test('with nothing failing, the first unknown hop with a reason shows it', () => {
  const [row] = chain(makeSnapshot({ missingBins: [BIN.dig] }), 80, G, false);
  expect(row).toContain('DNS ? dig: missing ──── Web ✔');
  const [both] = chain(makeSnapshot({ missingBins: [BIN.dig], http: makeHttp({ kind: 'portal' }) }), 100, G, false);
  expect(both).toContain('Web ✘ portal'); // a failure still wins over an unknown
  expect(both).not.toContain('dig: missing');
});
