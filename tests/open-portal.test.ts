import { test, expect } from 'bun:test';
import { isWebUrl, openUrl, portalUrl } from '../src/actions/open-portal';
import { makeHttp, makeSignals, makeSnapshot } from './helpers/snapshot';

test('portalUrl precedence (§8.4): redirect → --portal-url → captive.apple.com', () => {
  const none = makeSnapshot();
  expect(portalUrl(none, { portalUrl: null })).toBe('http://captive.apple.com/hotspot-detect.html');
  expect(portalUrl(none, { portalUrl: 'http://wifi.example/login' })).toBe('http://wifi.example/login');
  const sig = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: 'http://10.0.0.1/portal' }) });
  expect(portalUrl(sig, { portalUrl: 'http://wifi.example/login' })).toBe('http://10.0.0.1/portal');
  // last captive result is a portal with a redirect but signals did not carry it
  const http = makeSnapshot({ http: makeHttp({ kind: 'portal', code: 302, redirectUrl: 'http://10.0.0.2/login' }) });
  expect(portalUrl(http, { portalUrl: null })).toBe('http://10.0.0.2/login');
  // an ok result's (null) redirect is ignored
  const ok = makeSnapshot({ http: makeHttp({ kind: 'ok' }) });
  expect(portalUrl(ok, { portalUrl: null })).toBe('http://captive.apple.com/hotspot-detect.html');
  // empty --portal-url counts as absent
  expect(portalUrl(none, { portalUrl: '' })).toBe('http://captive.apple.com/hotspot-detect.html');
});

test('isWebUrl accepts only http(s) URLs', () => {
  expect(isWebUrl('http://captive.apple.com/hotspot-detect.html')).toBe(true);
  expect(isWebUrl('HTTPS://x.y/z?q=1')).toBe(true);
  expect(isWebUrl('file:///etc/passwd')).toBe(false);
  expect(isWebUrl('x-apple.systempreferences:com.apple.preference')).toBe(false);
  expect(isWebUrl('http://')).toBe(false);
  expect(isWebUrl('http://a b')).toBe(false);
});

test('openUrl refuses non-web URLs without spawning', async () => {
  const r = await openUrl('file:///etc/passwd');
  expect(r).toEqual({ ok: false, reason: 'not a web URL' });
});

test('a captured redirect that is only the detector URL is not a portal URL (§8.4)', () => {
  const APPLE = 'http://captive.apple.com/hotspot-detect.html';
  const GOOGLE = 'http://connectivitycheck.gstatic.com/generate_204';
  // a Location-less portal leaves the detector URL behind: --portal-url must still win
  const sig = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: APPLE }) });
  expect(portalUrl(sig, { portalUrl: 'http://wifi.example/login' })).toBe('http://wifi.example/login');
  expect(portalUrl(sig, { portalUrl: null })).toBe(APPLE);
  const g = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: GOOGLE }) });
  expect(portalUrl(g, { portalUrl: 'http://wifi.example/login' })).toBe('http://wifi.example/login');
  // a real redirect still wins over --portal-url
  const real = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: 'http://10.0.0.1/portal' }) });
  expect(portalUrl(real, { portalUrl: 'http://wifi.example/login' })).toBe('http://10.0.0.1/portal');
  // detector URL in signals must not hide a real redirect on the last captive result
  const both = makeSnapshot({
    signals: makeSignals({ portalRedirectUrl: APPLE }),
    http: makeHttp({ kind: 'portal', code: 302, redirectUrl: 'http://10.0.0.2/login' }),
  });
  expect(portalUrl(both, { portalUrl: null })).toBe('http://10.0.0.2/login');
});

test('a NETMON_CAPTIVE_URL override is filtered like the built-in detector URLs (§8.4)', () => {
  const OVERRIDE = 'http://10.255.255.1/x';
  const prev = process.env.NETMON_CAPTIVE_URL;
  process.env.NETMON_CAPTIVE_URL = OVERRIDE;
  try {
    // on a dev run the probe URL is the override, so it is what a Location-less portal leaves
    const sig = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: OVERRIDE }) });
    expect(portalUrl(sig, { portalUrl: 'http://wifi.example/login' })).toBe('http://wifi.example/login');
    // a real redirect from the override run still wins
    const real = makeSnapshot({ signals: makeSignals({ portalRedirectUrl: 'http://10.0.0.1/portal' }) });
    expect(portalUrl(real, { portalUrl: 'http://wifi.example/login' })).toBe('http://10.0.0.1/portal');
  } finally {
    if (prev === undefined) delete process.env.NETMON_CAPTIVE_URL;
    else process.env.NETMON_CAPTIVE_URL = prev;
  }
});
