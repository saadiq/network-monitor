import { test, expect } from 'bun:test';
import { hopDetail, hopList } from '../src/ui/sections/hops';
import { glyphs } from '../src/ui/ansi';
import { makeHttp, makeRoute, makeSignals, makeSnapshot, NOW } from './helpers/snapshot';

const G = glyphs(false);

test('hopList: the five mockup hops, all ok', () => {
  const hops = hopList(makeSnapshot(), G);
  expect(hops.map((h) => [h.name, h.mark])).toEqual([
    ['Wi-Fi', 'ok'], ['Router', 'ok'], ['Internet', 'ok'], ['DNS', 'ok'], ['Web', 'ok'],
  ]);
});

test('hopList hides Wi-Fi off the egress link and Router without a pingable gateway', () => {
  const hops = hopList(makeSnapshot({ wifiStatus: 'off', route: makeRoute({ pingGateway: null }) }), G);
  expect(hops.map((h) => h.name)).toEqual(['Internet', 'DNS', 'Web']);
});

test('hopDetail: a failing internet hop keeps its detail at compact level', () => {
  const down = makeSnapshot({
    state: 'DOWN', cause: 'uplink',
    signals: makeSignals({ inetLink: 'down', inetOk: false, inetDownSince: NOW - 42000 }),
    http: makeHttp({ kind: 'fail', exitCode: 7, code: null }),
  });
  const inet = hopList(down, G).find((h) => h.name === 'Internet');
  expect(inet?.mark).toBe('fail');
  expect(inet && hopDetail(inet, 'compact')).toBe('no reply 42s');
  expect(inet && hopDetail(inet, 'short')).toBe('42s');
});
