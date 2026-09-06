import { test, expect } from 'bun:test';
import { Alerter, bellCount } from '../src/actions/alerts';
import type { State, Transition } from '../src/model/types';

const BEL = '\x07';

function tr(from: State, to: State, at = 10_000): Transition {
  return { from, to, cause: null, at, wall: 1_757_168_000_000 + at, startedAt: 1_757_168_000_000 + at - 3000, startedAtMono: at - 3000 };
}

function collector() {
  const out: string[] = [];
  return { out, sink: (s: string) => { out.push(s); } };
}

test('bellCount table (§8.7)', () => {
  // → DOWN / NO_LINK: 1
  expect(bellCount(tr('UP', 'DOWN'))).toBe(1);
  expect(bellCount(tr('DEGRADED', 'DOWN'))).toBe(1);
  expect(bellCount(tr('UP', 'NO_LINK'))).toBe(1);
  expect(bellCount(tr('DOWN', 'NO_LINK'))).toBe(1);
  expect(bellCount(tr('PORTAL', 'DOWN'))).toBe(1);
  expect(bellCount(tr('WARMUP', 'DOWN'))).toBe(1);
  // → PORTAL: 2
  expect(bellCount(tr('UP', 'PORTAL'))).toBe(2);
  expect(bellCount(tr('DOWN', 'PORTAL'))).toBe(2);
  // outage → UP / DEGRADED: 2
  expect(bellCount(tr('DOWN', 'UP'))).toBe(2);
  expect(bellCount(tr('PORTAL', 'DEGRADED'))).toBe(2);
  expect(bellCount(tr('NO_LINK', 'UP'))).toBe(2);
  // not alert-worthy: 0
  expect(bellCount(tr('WARMUP', 'UP'))).toBe(0);
  expect(bellCount(tr('UP', 'DEGRADED'))).toBe(0);
  expect(bellCount(tr('DEGRADED', 'UP'))).toBe(0);
  expect(bellCount(tr('DOWN', 'WARMUP'))).toBe(0); // sleep gap → WARMUP is silent
  expect(bellCount(tr('UP', 'WARMUP'))).toBe(0);
});

test('rings the burst through the injected sink', () => {
  const { out, sink } = collector();
  const a = new Alerter(sink);
  expect(a.enabled).toBe(true);
  expect(a.onTransition(tr('UP', 'DOWN', 1000), 1000)).toBe(1);
  expect(out).toEqual([BEL]);
  expect(a.onTransition(tr('DOWN', 'UP', 20_000), 20_000)).toBe(2);
  expect(out).toEqual([BEL, BEL + BEL]);
});

test('silent transitions write nothing and do not touch the rate limiter', () => {
  const { out, sink } = collector();
  const a = new Alerter(sink);
  expect(a.onTransition(tr('WARMUP', 'UP', 1000), 1000)).toBe(0);
  expect(out).toEqual([]);
  expect(a.onTransition(tr('UP', 'DOWN', 2000), 2000)).toBe(1); // 1 s later still rings
  expect(out).toEqual([BEL]);
});

test('at most one burst per 5 s', () => {
  const { out, sink } = collector();
  const a = new Alerter(sink);
  expect(a.onTransition(tr('UP', 'DOWN', 1000), 1000)).toBe(1);
  expect(a.onTransition(tr('DOWN', 'PORTAL', 4000), 4000)).toBe(0); // 3 s later: suppressed
  expect(a.onTransition(tr('PORTAL', 'UP', 5999), 5999)).toBe(0); // 4.999 s: suppressed
  expect(a.onTransition(tr('UP', 'DOWN', 6000), 6000)).toBe(1); // exactly 5 s after the last burst: rings
  expect(out).toEqual([BEL, BEL]);
  // a suppressed burst does not extend the window
  expect(a.onTransition(tr('DOWN', 'UP', 9000), 9000)).toBe(0);
  expect(a.onTransition(tr('UP', 'DOWN', 11_000), 11_000)).toBe(1);
  expect(out.length).toBe(3);
});

test('now defaults to t.at', () => {
  const { out, sink } = collector();
  const a = new Alerter(sink);
  expect(a.onTransition(tr('UP', 'DOWN', 1000))).toBe(1);
  expect(a.onTransition(tr('DOWN', 'UP', 3000))).toBe(0);
  expect(a.onTransition(tr('UP', 'DOWN', 6000))).toBe(1);
  expect(out.length).toBe(2);
});

test('toggle and --no-bell', () => {
  const { out, sink } = collector();
  const a = new Alerter(sink);
  expect(a.toggle()).toBe(false);
  expect(a.enabled).toBe(false);
  expect(a.onTransition(tr('UP', 'DOWN', 1000), 1000)).toBe(0);
  expect(out).toEqual([]);
  expect(a.toggle()).toBe(true);
  expect(a.onTransition(tr('DOWN', 'UP', 1500), 1500)).toBe(2); // muted transitions did not arm the limiter
  expect(out).toEqual([BEL + BEL]);

  const b = new Alerter(sink, false); // --no-bell
  expect(b.enabled).toBe(false);
  expect(b.onTransition(tr('UP', 'PORTAL', 1000), 1000)).toBe(0);
  b.enabled = true;
  expect(b.onTransition(tr('UP', 'PORTAL', 1000), 1000)).toBe(2);
});
