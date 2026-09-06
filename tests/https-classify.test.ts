import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildHttpsArgs, classifyHttps, toHttpsResult, HttpsPoller } from '../src/probes/https';
import { fakeResult, type RunFn } from '../src/probes/run-types';
import { BIN, HTTPS_PROCESS_TIMEOUT_MS, HTTPS_URL } from '../src/config';

const trace = readFileSync(`${import.meta.dir}/fixtures/https-trace.txt`, 'utf8');

test('buildHttpsArgs matches §4.4 exactly', () => {
  expect(buildHttpsArgs()).toEqual([
    BIN.curl, '-4', '-s', '-m', '6', '-A', 'netmon/1', '-o', '-',
    '-w', '\\n@@|%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_total}',
    HTTPS_URL,
  ]);
});

test('classifyHttps: 200 with ip= → ok', () => {
  expect(classifyHttps(0, 200, 'fl=1\nh=www.cloudflare.com\nip=1.2.3.4\nts=1\n')).toBe('ok');
  expect(classifyHttps(0, 200, 'ip=2001:db8::1\n')).toBe('ok');
});

test('classifyHttps: exit 35/60 or 3xx → portal', () => {
  expect(classifyHttps(35, null, '')).toBe('portal');
  expect(classifyHttps(60, null, '')).toBe('portal');
  expect(classifyHttps(0, 302, '')).toBe('portal');
  expect(classifyHttps(0, 307, 'ip=1.2.3.4')).toBe('portal');
});

test('classifyHttps: everything else → fail', () => {
  expect(classifyHttps(28, null, '')).toBe('fail');
  expect(classifyHttps(7, null, '')).toBe('fail');
  expect(classifyHttps(null, null, '')).toBe('fail');
  expect(classifyHttps(0, 200, '<html>no trace here</html>')).toBe('fail');
  expect(classifyHttps(0, 200, 'x ip=1.2.3.4')).toBe('fail'); // ip= must start a line
  expect(classifyHttps(0, 403, 'ip=1.2.3.4')).toBe('fail');
  expect(classifyHttps(0, 511, 'ip=1.2.3.4')).toBe('fail'); // §4.4 lists only 3xx for HTTPS
});

test('toHttpsResult parses the captured trace', () => {
  const r = toHttpsResult(fakeResult(trace), 77);
  expect(r).toEqual({ kind: 'ok', code: 200, exitCode: 0, startedAt: 77, ms: 82 });
  const tls = toHttpsResult(fakeResult('\n@@|000|0.01|0.02|0.000000|0.05', 35), 1);
  expect(tls).toEqual({ kind: 'portal', code: null, exitCode: 35, startedAt: 1, ms: 50 });
  const killed = toHttpsResult(fakeResult('', null, { timedOut: true }), 2);
  expect(killed).toEqual({ kind: 'fail', code: null, exitCode: null, startedAt: 2, ms: null });
});

test('HttpsPoller: immediate run, cadence, triggerNow honours the min gap', async () => {
  const starts: number[] = [];
  const t0 = performance.now();
  const run: RunFn = async (_argv, timeoutMs) => {
    expect(timeoutMs).toBe(HTTPS_PROCESS_TIMEOUT_MS);
    starts.push(performance.now() - t0);
    return fakeResult(trace);
  };
  const p = new HttpsPoller(run, { cadenceMs: 400, minGapMs: 60 });
  const kinds: string[] = [];
  p.start((r) => kinds.push(r.kind));
  await Bun.sleep(10);
  expect(starts.length).toBe(1);
  p.triggerNow(); // 10 ms after the first start → deferred to ~60 ms, not immediate
  await Bun.sleep(20);
  expect(starts.length).toBe(1);
  await Bun.sleep(60);
  expect(starts.length).toBe(2);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(55);
  p.triggerNow(); // < 60 ms after the second start → deferred again
  p.triggerNow(); // duplicate requests collapse into one
  await Bun.sleep(100);
  expect(starts.length).toBe(3);
  p.stop();
  await Bun.sleep(30);
  expect(starts.length).toBe(3);
  expect(kinds).toEqual(['ok', 'ok', 'ok']);
});

test('HttpsPoller: triggerNow after the gap runs immediately', async () => {
  let n = 0;
  const run: RunFn = async () => { n += 1; return fakeResult(trace); };
  const p = new HttpsPoller(run, { cadenceMs: 10000, minGapMs: 20 });
  p.start(() => {});
  await Bun.sleep(40);
  expect(n).toBe(1);
  p.triggerNow();
  await Bun.sleep(10);
  expect(n).toBe(2);
  p.stop();
});

test('NETMON_HTTPS_URL overrides the §4.4 endpoint (dev-only, http(s) only)', () => {
  const prev = process.env['NETMON_HTTPS_URL'];
  try {
    process.env['NETMON_HTTPS_URL'] = 'https://10.255.255.1/trace';
    expect(buildHttpsArgs()[buildHttpsArgs().length - 1]).toBe('https://10.255.255.1/trace');
    process.env['NETMON_HTTPS_URL'] = 'notaurl';
    expect(buildHttpsArgs()[buildHttpsArgs().length - 1]).toBe(HTTPS_URL);
  } finally {
    if (prev === undefined) delete process.env['NETMON_HTTPS_URL'];
    else process.env['NETMON_HTTPS_URL'] = prev;
  }
});
