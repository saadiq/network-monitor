import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildCaptiveArgs, parseCurlOut, classifyCaptive, toHttpResult, HttpPoller } from '../src/probes/http';
import { fakeResult, type RunFn } from '../src/probes/run-types';
import { BIN, CAPTIVE_DETECTORS, HTTP_PROCESS_TIMEOUT_MS } from '../src/config';
import { Store } from '../src/model/store';

const fx = (name: string) => readFileSync(`${import.meta.dir}/fixtures/${name}`, 'utf8');
const apple = fx('captive-apple.txt');
const google = fx('captive-google.txt');
const DNSFAIL_OUT = '\n@@|000||0.000000|0.000000|0.086444|0'; // captured: curl exit 6

test('buildCaptiveArgs matches §4.3 exactly, never -L', () => {
  expect(buildCaptiveArgs('apple')).toEqual([
    BIN.curl, '-4', '-s', '-m', '4', '-A', 'netmon/1', '-o', '-',
    '-w', '\\n@@|%{http_code}|%{redirect_url}|%{time_namelookup}|%{time_connect}|%{time_total}|%{size_download}',
    'http://captive.apple.com/hotspot-detect.html',
  ]);
  const g = buildCaptiveArgs('google');
  expect(g[g.length - 1]).toBe('http://connectivitycheck.gstatic.com/generate_204');
  expect(g).not.toContain('-L');
});

test('parseCurlOut: apple fixture body + fields', () => {
  const { body, fields } = parseCurlOut(apple);
  expect(body).toContain('<TITLE>Success</TITLE>');
  expect(body.endsWith('\n')).toBe(true); // apple body has its own trailing newline
  expect(fields).toEqual(['200', '', '0.017490', '0.027154', '0.042499', '69']);
});

test('parseCurlOut: empty body (google 204) and empty redirect_url keep field positions', () => {
  const { body, fields } = parseCurlOut(google);
  expect(body).toBe('');
  expect(fields).toEqual(['204', '', '0.014671', '0.026894', '0.039666', '0']);
});

test('parseCurlOut splits on the LAST marker and tolerates a missing marker', () => {
  const tricky = 'x\n@@|fake|y\n@@|302|http://p/login||0.01|0.02|0';
  const r = parseCurlOut(tricky);
  expect(r.body).toBe('x\n@@|fake|y');
  expect(r.fields).toEqual(['302', 'http://p/login', '', '0.01', '0.02', '0']);
  expect(parseCurlOut('garbage')).toEqual({ body: 'garbage', fields: [] });
  expect(parseCurlOut('')).toEqual({ body: '', fields: [] });
});

test('classifyCaptive rule order (§4.3 table)', () => {
  expect(classifyCaptive(6, 'apple', null, '', '', 0)).toBe('dnsfail');
  expect(classifyCaptive(7, 'apple', null, '', '', 0)).toBe('fail');
  expect(classifyCaptive(28, 'google', null, '', '', 0)).toBe('fail');
  expect(classifyCaptive(35, 'apple', null, '', '', 0)).toBe('fail');
  expect(classifyCaptive(null, 'apple', null, '', '', 0)).toBe('fail'); // killed / spawn error
  expect(classifyCaptive(7, 'apple', 302, '', 'http://x', 0)).toBe('fail'); // exit checked first
  expect(classifyCaptive(0, 'apple', 302, '', 'http://portal/login', 0)).toBe('portal');
  expect(classifyCaptive(0, 'google', 307, '', '', 0)).toBe('portal');
  expect(classifyCaptive(0, 'apple', 511, 'Success', '', 7)).toBe('portal');
  expect(classifyCaptive(0, 'apple', 200, '<TITLE>Success</TITLE>', '', 69)).toBe('ok');
  expect(classifyCaptive(0, 'apple', 200, '<html>login</html>', '', 500)).toBe('portal');
  expect(classifyCaptive(0, 'google', 204, '', '', 0)).toBe('ok');
  expect(classifyCaptive(0, 'google', 204, 'x', '', 1)).toBe('fail');
  expect(classifyCaptive(0, 'google', 200, '<html>login</html>', '', 500)).toBe('portal');
  expect(classifyCaptive(0, 'google', 200, 'Success', '', 7)).toBe('portal'); // google 200 is never ok
  expect(classifyCaptive(0, 'apple', 404, '', '', 0)).toBe('fail');
  expect(classifyCaptive(0, 'apple', 503, 'Success', '', 0)).toBe('fail');
  expect(classifyCaptive(0, 'google', 500, '', '', 0)).toBe('fail');
});

test('toHttpResult derives ms / connectMs / code from the fixture', () => {
  const r = toHttpResult('apple', fakeResult(apple), 1234);
  expect(r).toEqual({
    kind: 'ok', detector: 'apple', url: CAPTIVE_DETECTORS.apple, code: 200, exitCode: 0,
    startedAt: 1234, ms: 42, connectMs: 10, redirectUrl: null,
  });
  const g = toHttpResult('google', fakeResult(google), 5);
  expect(g.kind).toBe('ok');
  expect(g.code).toBe(204);
  expect(g.ms).toBe(40);
  expect(g.connectMs).toBe(12);
});

test('toHttpResult: exit 6 → dnsfail with null code/connectMs; timeouts → fail', () => {
  const d = toHttpResult('apple', fakeResult(DNSFAIL_OUT, 6), 0);
  expect(d.kind).toBe('dnsfail');
  expect(d.code).toBeNull();
  expect(d.exitCode).toBe(6);
  expect(d.connectMs).toBeNull();
  const t = toHttpResult('google', fakeResult('', null, { timedOut: true }), 0);
  expect(t.kind).toBe('fail');
  expect(t.code).toBeNull();
  expect(t.ms).toBeNull();
  const e = toHttpResult('google', fakeResult('', null, { err: 'ENOENT' }), 0);
  expect(e.kind).toBe('fail');
});

test('toHttpResult: only a 3xx/511 portal falls back to the detector URL (§4.3 table)', () => {
  const withLoc = toHttpResult('apple', fakeResult('\n@@|302|http://portal/login|0.01|0.02|0.03|0'), 0);
  expect(withLoc.kind).toBe('portal');
  expect(withLoc.redirectUrl).toBe('http://portal/login');
  const redirNoLoc = toHttpResult('apple', fakeResult('\n@@|302||0.01|0.02|0.03|0'), 0);
  expect(redirNoLoc.redirectUrl).toBe(CAPTIVE_DETECTORS.apple); // Location-less 3xx keeps the detector URL
  expect(toHttpResult('google', fakeResult('\n@@|511||0.01|0.02|0.03|0'), 0).redirectUrl).toBe(CAPTIVE_DETECTORS.google);
  // weak evidence (200 without Success / google 200): no substitution, so §6.1 `strong` stays false
  const appleWeak = toHttpResult('apple', fakeResult('<html>login</html>\n@@|200||0.01|0.02|0.03|18'), 0);
  expect(appleWeak.kind).toBe('portal');
  expect(appleWeak.redirectUrl).toBeNull();
  const googleWeak = toHttpResult('google', fakeResult('<html>login</html>\n@@|200||0.01|0.02|0.03|18'), 0);
  expect(googleWeak.kind).toBe('portal');
  expect(googleWeak.redirectUrl).toBeNull();
  // a weak 200 that did report a Location keeps it (curl reported it; nothing is invented)
  expect(toHttpResult('google', fakeResult('x\n@@|200|http://p/login|0.01|0.02|0.03|1'), 0).redirectUrl).toBe('http://p/login');
});

// §4.3 / §6.1 through the real pipeline (toHttpResult → Store), not the sim helper.
const weakPortal = (detector: 'apple' | 'google', at: number) =>
  toHttpResult(detector, fakeResult('<html>login</html>\n@@|200||0.01|0.02|0.03|18'), at);
const NO_STREAMS = { inetStalled: true, gwStalled: true, gwActive: false };
const newStore = () => new Store({ target: '1.1.1.1', now: 0, wall: Date.UTC(2026, 8, 6, 14) });

test('pipeline: one Location-less 200 portal result is weak — two are needed to enter PORTAL', () => {
  const store = newStore();
  store.onHttp(weakPortal('apple', 1000));
  const t1 = store.tick(1000, Date.UTC(2026, 8, 6, 14) + 1000, 1000, NO_STREAMS);
  expect(store.sig.portalSignal).toBe(false);
  expect(t1.snap.state).not.toBe('PORTAL');
  store.onHttp(weakPortal('google', 2000));
  const t2 = store.tick(2000, Date.UTC(2026, 8, 6, 14) + 2000, 1000, NO_STREAMS);
  expect(store.sig.portalSignal).toBe(true);
  expect(t2.snap.state).toBe('PORTAL');
});

test('pipeline: a single 3xx (or 511) portal result is strong and enters PORTAL at once', () => {
  const store = newStore();
  store.onHttp(toHttpResult('apple', fakeResult('\n@@|302|http://portal/login|0.01|0.02|0.03|0'), 1000));
  const t1 = store.tick(1000, Date.UTC(2026, 8, 6, 14) + 1000, 1000, NO_STREAMS);
  expect(store.sig.portalSignal).toBe(true);
  expect(t1.snap.state).toBe('PORTAL');
  expect(store.sig.portalRedirectUrl).toBe('http://portal/login');
  const s511 = newStore();
  s511.onHttp(toHttpResult('google', fakeResult('\n@@|511||0.01|0.02|0.03|0'), 1000));
  s511.tick(1000, Date.UTC(2026, 8, 6, 14) + 1000, 1000, NO_STREAMS);
  expect(s511.sig.portalSignal).toBe(true);
});

test('HttpPoller alternates detectors, is single-flight, tracks webFailStreak', async () => {
  const calls: string[][] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const script = [apple, google, '\n@@|000||0|0|4.0|0', '\n@@|000||0|0|4.0|0', apple];
  const run: RunFn = async (argv, timeoutMs) => {
    expect(timeoutMs).toBe(HTTP_PROCESS_TIMEOUT_MS);
    calls.push(argv);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await Bun.sleep(5);
    concurrent -= 1;
    const out = script.shift() ?? apple;
    return fakeResult(out, out.includes('|000|') ? 28 : 0);
  };
  const p = new HttpPoller(run);
  const kinds: string[] = [];
  const streaks: number[] = [];
  p.start((r) => { kinds.push(r.kind); streaks.push(p.webFailStreak); });
  p.setCadence(15);
  p.triggerNow(); // while the first is in flight → one queued follow-up, never concurrent
  await Bun.sleep(120);
  p.stop();
  const n = kinds.length;
  await Bun.sleep(40);
  expect(kinds.length).toBe(n); // stop() halts scheduling
  expect(maxConcurrent).toBe(1);
  expect(kinds.slice(0, 5)).toEqual(['ok', 'ok', 'fail', 'fail', 'ok']);
  expect(streaks.slice(0, 5)).toEqual([0, 0, 1, 2, 0]);
  const urls = calls.map((a) => a[a.length - 1]);
  expect(urls.slice(0, 4)).toEqual([CAPTIVE_DETECTORS.apple, CAPTIVE_DETECTORS.google, CAPTIVE_DETECTORS.apple, CAPTIVE_DETECTORS.google]);
});

test('HttpPoller.setCadence reschedules the pending timer', async () => {
  let n = 0;
  const run: RunFn = async () => { n += 1; return fakeResult(apple); };
  const p = new HttpPoller(run);
  p.start(() => {});
  await Bun.sleep(10);
  expect(n).toBe(1); // default cadence 10 s: only the immediate run
  p.setCadence(20);
  await Bun.sleep(60);
  p.stop();
  expect(n).toBeGreaterThanOrEqual(3);
});

// ---- dev-only endpoint override (documented in CLAUDE.md, deliberately absent from --help) ----

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('NETMON_CAPTIVE_URL redirects the captive check at an unreachable endpoint', () => {
  withEnv('NETMON_CAPTIVE_URL', 'http://10.255.255.1/x', () => {
    expect(buildCaptiveArgs('apple')[buildCaptiveArgs('apple').length - 1]).toBe('http://10.255.255.1/x');
    expect(buildCaptiveArgs('google')[buildCaptiveArgs('google').length - 1]).toBe('http://10.255.255.1/x');
    const r = toHttpResult('apple', fakeResult('\n@@|302||0.01|0.02|0.03|0'), 0);
    expect(r.url).toBe('http://10.255.255.1/x'); // the result names the URL actually probed
    expect(r.redirectUrl).toBe('http://10.255.255.1/x');
  });
  withEnv('NETMON_CAPTIVE_URL', 'file:///etc/passwd', () => { // http(s) only; anything else ignored
    expect(buildCaptiveArgs('apple')[buildCaptiveArgs('apple').length - 1]).toBe(CAPTIVE_DETECTORS.apple);
  });
  withEnv('NETMON_CAPTIVE_URL', undefined, () => {
    expect(buildCaptiveArgs('google')[buildCaptiveArgs('google').length - 1]).toBe(CAPTIVE_DETECTORS.google);
  });
});
