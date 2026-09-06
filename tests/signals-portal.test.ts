import { test, expect } from 'bun:test';
import { Sim, http, https, link } from './status-sim';

const strong = (at: number, detector: 'apple' | 'google' = 'google') =>
  http('portal', at, { detector, code: 302, redirectUrl: 'http://login.example' });

test('one portal result with a redirect enters PORTAL immediately, backdated to its startedAt', () => {
  const s = new Sim();
  s.run(2);
  const t = s.step({ captive: [http('ok', 0), strong(2_500)] });
  expect(t).toMatchObject({ from: 'UP', to: 'PORTAL', cause: 'portal', at: 3_000, startedAtMono: 2_500 });
  expect(s.sig.portalSignal).toBe(true);
  expect(s.sig.portalSince).toBe(2_500);
  expect(s.sig.portalRedirectUrl).toBe('http://login.example');
});

test('code 511 counts as strong evidence; a Location-less 200 needs a second portal result', () => {
  const s = new Sim();
  s.run(2);
  expect(s.step({ captive: [http('ok', 0), http('portal', 2_500, { code: 511 })] })?.to).toBe('PORTAL');

  const s2 = new Sim();
  s2.run(2);
  const weak1 = http('portal', 2_500, { code: 200 });
  expect(s2.run(3, { captive: [http('ok', 0), weak1] })).toEqual([]);
  expect(s2.sig.portalSignal).toBe(false);
  const weak2 = http('portal', 5_500, { code: 200, detector: 'google' });
  expect(s2.step({ captive: [http('ok', 0), weak1, weak2] })).toMatchObject({ to: 'PORTAL', startedAtMono: 2_500 });
  expect(s2.sig.portalRedirectUrl).toBeNull();
});

test('portal exits only after two consecutive ok results from different detectors', () => {
  const s = new Sim();
  s.run(2);
  const p = strong(2_500);
  s.step({ captive: [http('ok', 0), p] });
  expect(s.sm.state).toBe('PORTAL');
  const ok1 = http('ok', 4_000, { detector: 'apple' });
  expect(s.run(3, { captive: [http('ok', 0), p, ok1] })).toEqual([]); // t=6
  const okSame = http('ok', 6_000, { detector: 'apple' });
  expect(s.run(3, { captive: [p, ok1, okSame] })).toEqual([]); // t=9
  expect(s.sig.portalSignal).toBe(true);
  const ok2 = http('ok', 9_500, { detector: 'google' });
  expect(s.step({ captive: [ok1, okSame, ok2] })).toBeNull(); // t=10
  expect(s.sig.portalSignal).toBe(false);
  // backdated to the first ok of the trailing run (4_000), not the newest one that cleared the signal
  expect(s.step({ captive: [ok1, okSame, ok2] })).toMatchObject({ from: 'PORTAL', to: 'UP', at: 11_000, startedAtMono: 4_000 });
  expect(s.sig.portalRedirectUrl).toBe('http://login.example'); // kept for the `o` key
});

test('PORTAL → UP is backdated to the first ok of the run, not the newest result', () => {
  const s = new Sim();
  s.run(2);
  const p = strong(2_500);
  s.step({ captive: [http('ok', 0), p] }); // t=3: PORTAL
  expect(s.sm.state).toBe('PORTAL');
  const ok1 = http('ok', 3_500, { detector: 'apple' });
  const ok2 = http('ok', 4_500, { detector: 'google' });
  const back = { captive: [p, ok1, ok2] };
  expect(s.step(back)).toBeNull(); // t=4: signal cleared, UP pending
  expect(s.sig.portalSignal).toBe(false);
  expect(s.step(back)).toMatchObject({ from: 'PORTAL', to: 'UP', at: 5_000, startedAtMono: 3_500 });
});

test('a fail between two oks breaks the consecutive rule', () => {
  const s = new Sim();
  s.run(2);
  const p = strong(2_500);
  s.step({ captive: [http('ok', 0), p] });
  const seq = [http('ok', 9_000, { detector: 'apple' }), http('fail', 12_000, { detector: 'google' }), http('ok', 15_000, { detector: 'apple' })];
  expect(s.run(3, { captive: seq })).toEqual([]);
  expect(s.sm.state).toBe('PORTAL');
});

test('one HTTPS ok clears the portal; an HTTPS ok that predates the portal does not', () => {
  const s = new Sim();
  s.run(2);
  const p = strong(2_500);
  s.step({ captive: [http('ok', 0), p], https: https('ok', 1_000) });
  expect(s.sm.state).toBe('PORTAL');
  expect(s.run(2, { captive: [http('ok', 0), p], https: https('ok', 1_000) })).toEqual([]);
  s.step({ captive: [http('ok', 0), p], https: https('ok', 7_000) });
  expect(s.sig.portalSignal).toBe(false);
  expect(s.step({ captive: [http('ok', 0), p], https: https('ok', 7_000) })?.to).toBe('UP');
});

test('HTTPS portal alone is weak evidence; it counts as a prior portal for the next captive portal', () => {
  const s = new Sim();
  s.run(2);
  expect(s.run(2, { captive: [http('ok', 0)], https: https('portal', 2_500) })).toEqual([]);
  expect(s.sig.portalSignal).toBe(false);
  expect(s.step({ captive: [http('ok', 0), http('portal', 4_500, { code: 200 })], https: https('portal', 2_500) }))
    .toMatchObject({ to: 'PORTAL', startedAtMono: 2_500 });
});

test('a portal that whitelists the apple detector cannot make the state flap', () => {
  const s = new Sim();
  s.run(2);
  let captive = [http('ok', 0), strong(2_500)];
  expect(s.step({ captive })?.to).toBe('PORTAL');
  for (let round = 0; round < 4; round++) {
    const base = 5_500 + round * 6_000;
    captive = [...captive.slice(-2), http('ok', base, { detector: 'apple' })];
    expect(s.run(3, { captive })).toEqual([]);
    captive = [...captive.slice(-2), strong(base + 3_000)];
    expect(s.run(3, { captive })).toEqual([]);
  }
  expect(s.sm.state).toBe('PORTAL');
});

test('DOWN(uplink) → PORTAL when the portal appears as the uplink returns', () => {
  const s = new Sim();
  s.run(2);
  const down = link('down', { downSince: 2_020 });
  s.run(2, { inet: down, captive: [http('fail', 1_000)] });
  expect(s.sm.state).toBe('DOWN');
  const captive = [http('fail', 1_000), strong(4_500)];
  expect(s.step({ inet: down, captive })).toMatchObject({ from: 'DOWN', to: 'PORTAL', cause: 'portal', at: 5_000, startedAtMono: 4_500 });
});

test('portal wins over WARMUP and DOWN rows; NO_LINK wins over portal', () => {
  const s = new Sim();
  expect(s.step({ inet: link('unknown'), captive: [strong(500)] })?.to).toBe('PORTAL');
  const s2 = new Sim();
  s2.run(2);
  s2.step({ captive: [strong(2_500)] });
  expect(s2.step({ captive: [strong(2_500)], route: { ...s2.inputs({}).route!, hasRoute: false, at: 3_500 } }))
    .toMatchObject({ from: 'PORTAL', to: 'NO_LINK', startedAtMono: 3_500 });
});
