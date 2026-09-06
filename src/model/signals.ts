// §6.1 / §6.2 inputs: derive the per-tick Signals from probe state. Pure; `now` injected.
// Latches (portal, ICMP-blocked, gwNoIcmp, grace) live in the previous tick's Signals (`prev`).
import {
  DNS_FRESH_MS, GRACE_HTTP_FRESH_MS, GRACE_MS, GW_NO_ICMP_HOLD_MS, HTTP_STALE_MS,
  ICMP_BLOCKED_AFTER_MS, ICMP_BLOCKED_HTTP_OK, PORTAL_EXIT_OK, WIFI_STALE_MS,
} from '../config';
import type { HttpResult, HttpsResult, RouteInfo, Timed, WifiInfo } from '../probes/types';
import type { Grade, LinkState, Signals } from './types';

/** Per-stream link facts from a SampleWindow (§6.1). Times are monotonic send times. */
export interface StreamLink {
  link: LinkState;
  downSince: number | null; // first LOST of the run that produced 'down'
  upSince: number | null; // first RECEIVED/LATE of the recovery run
  lastReceivedAt: number | null; // newest RECEIVED/LATE sample (clears the ICMP latch)
}

/** What the store hands to deriveSignals each tick. */
export interface SignalInputs {
  gw: StreamLink;
  inet: StreamLink;
  captive: readonly HttpResult[]; // last ≤ 3 captive results, oldest → newest
  https: HttpsResult | null; // latest §4.4 result
  webFailStreak: number; // consecutive captive `fail` results (§4.3)
  dnsSysOkAt: number | null; // monotonic time of the last successful system-path dig
  dnsDirectOkAt: number | null;
  dnsDisabled?: boolean; // dig missing at preflight → DNS treated as ok
  route: RouteInfo | null; // null before the first route probe (treated as "has route")
  wifi: Timed<WifiInfo> | null;
  heldGrade: Grade;
  gapMs: number;
  prev: Signals | null; // previous tick's output
}

interface Evidence {
  kind: 'ok' | 'portal' | 'fail' | 'dnsfail';
  startedAt: number;
  src: 'captive' | 'https';
  strong: boolean; // captive portal with a redirectUrl or code 511 (§6.1)
}

/** Captive + HTTPS results merged by startedAt; the last three. */
function evidence(captive: readonly HttpResult[], https: HttpsResult | null): Evidence[] {
  const ev: Evidence[] = captive.map((r) => ({
    kind: r.kind, startedAt: r.startedAt, src: 'captive',
    strong: r.kind === 'portal' && ((r.redirectUrl ?? '') !== '' || r.code === 511),
  }));
  if (https) ev.push({ kind: https.kind, startedAt: https.startedAt, src: 'https', strong: false });
  ev.sort((a, b) => a.startedAt - b.startedAt);
  return ev.slice(-3);
}

/**
 * §6.3 recovery backdating: the startedAt of the first ok of the trailing all-ok run (the moment
 * the connection actually came back), carried across the kept-results window; when the newest
 * result is not ok, the last ok seen (as before).
 */
function okRunSince(captive: readonly HttpResult[], prev: Signals | null): number | null {
  let since: number | null = null;
  for (let i = captive.length - 1; i >= 0; i--) {
    const r = captive[i] as HttpResult;
    if (r.kind !== 'ok') break;
    since = r.startedAt;
  }
  const carried = prev?.lastHttpOkAt ?? null;
  if (since === null) return carried;
  const full = since === captive[0]?.startedAt; // the run may reach past the kept results
  return full && carried !== null && carried < since ? carried : since;
}

/** §4.3 exit: the last two captive results are ok and come from different detectors. */
function twoOkDetectors(captive: readonly HttpResult[]): boolean {
  const tail = captive.slice(-PORTAL_EXIT_OK);
  if (tail.length < PORTAL_EXIT_OK || !tail.every((r) => r.kind === 'ok')) return false;
  return new Set(tail.map((r) => r.detector)).size === tail.length;
}

type PortalOut = Pick<Signals, 'portalSignal' | 'portalSince' | 'portalRedirectUrl'>;

// §6.1 portal signal: strong single result or two of the last three; exits on two oks / HTTPS ok.
function derivePortal(input: SignalInputs): PortalOut {
  const prev = input.prev;
  const ev = evidence(input.captive, input.https);
  const last = ev[ev.length - 1];
  let signal = prev?.portalSignal ?? false;
  let since = prev?.portalSince ?? null;
  if (last?.kind === 'portal' && !signal) {
    const prior = ev.slice(0, -1).some((e) => e.kind === 'portal');
    if (last.strong || prior) {
      signal = true;
      since = Math.min(...ev.filter((e) => e.kind === 'portal').map((e) => e.startedAt));
    }
  } else if (last?.kind === 'ok' && signal) {
    if (last.src === 'https' || twoOkDetectors(input.captive)) signal = false;
  }
  const redirect = [...input.captive].reverse().find((r) => r.kind === 'portal' && (r.redirectUrl ?? '') !== '');
  return {
    portalSignal: signal,
    portalSince: signal ? since : null,
    portalRedirectUrl: redirect?.redirectUrl ?? prev?.portalRedirectUrl ?? null,
  };
}

// §6.1 latch: inet down ≥ 30 s with the last 2 captive ok; cleared by any RECEIVED/LATE sample.
function deriveIcmpBlocked(input: SignalInputs, now: number): boolean {
  const { inet, captive, prev } = input;
  const receivedSince = inet.lastReceivedAt != null && inet.downSince != null && inet.lastReceivedAt > inet.downSince;
  if (inet.link === 'up' || receivedSince) return false;
  if (prev?.icmpBlocked) return true;
  if (inet.link !== 'down' || inet.downSince == null) return false;
  const tail = captive.slice(-ICMP_BLOCKED_HTTP_OK);
  return now - inet.downSince >= ICMP_BLOCKED_AFTER_MS
    && tail.length === ICMP_BLOCKED_HTTP_OK && tail.every((r) => r.kind === 'ok');
}

// §6.2 inetOk formula.
function deriveInetOk(inet: StreamLink, http: HttpResult | null, now: number, icmpBlocked: boolean): boolean {
  if (inet.link === 'up') return true;
  if (!http || now - http.startedAt > HTTP_STALE_MS) return false;
  if (icmpBlocked && http.kind !== 'fail') return true;
  return http.kind === 'ok' && http.startedAt >= (inet.downSince ?? -Infinity);
}

type GwNoIcmpOut = Pick<Signals, 'gwNoIcmp' | 'gwNoIcmpSince'>;

/**
 * §6.1 `gwNoIcmp`: the raw formula is `gateway down && inetOk`. It is carried through a later
 * uplink drop (so that drop is not blamed on the router) only once it has held for
 * GW_NO_ICMP_HOLD_MS — a single tick where the gateway stream flipped down before the internet
 * one is a coincidence of two ping phases, not a router that ignores ICMP.
 */
function deriveGwNoIcmp(gw: StreamLink, inetOk: boolean, prev: Signals | null, now: number): GwNoIcmpOut {
  const raw = gw.link === 'down' && inetOk;
  const prevSince = prev?.gwNoIcmpSince ?? null;
  const held = prevSince != null && now - prevSince >= GW_NO_ICMP_HOLD_MS;
  let since: number | null = null;
  if (gw.link === 'down') since = raw ? (prevSince ?? now) : (held ? prevSince : null);
  return { gwNoIcmp: since != null && (raw || held), gwNoIcmpSince: since };
}

type GraceOut = Pick<Signals, 'grace' | 'graceUntil'>;

// §6.2 confirmation grace: ≤ 5 s after the inet flip while the out-of-band check is in flight.
function deriveGrace(input: SignalInputs, http: HttpResult | null, now: number, inetOk: boolean): GraceOut {
  const { inet, prev } = input;
  let until = prev?.graceUntil ?? null;
  if (inet.link === 'down' && prev != null && prev.inetLink !== 'down') {
    const fresh = http != null && http.kind === 'ok' && now - http.startedAt <= GRACE_HTTP_FRESH_MS;
    until = fresh ? now + GRACE_MS : null;
  }
  if (until != null) {
    const answered = http != null && http.startedAt >= until - GRACE_MS; // a check launched at/after the flip
    if (now >= until || inet.link !== 'down' || inetOk || answered) until = null;
  }
  return { grace: until != null, graceUntil: until };
}

export function deriveSignals(input: SignalInputs, now: number): Signals {
  const { gw, inet, prev, route } = input;
  const http = input.captive[input.captive.length - 1] ?? null;
  const wifi = input.wifi != null && now - input.wifi.at <= WIFI_STALE_MS ? input.wifi : null;
  const icmpBlocked = deriveIcmpBlocked(input, now);
  const inetOk = deriveInetOk(inet, http, now, icmpBlocked);
  const grace = deriveGrace(input, http, now, inetOk);
  const portal = derivePortal(input);
  const gwNoIcmp = deriveGwNoIcmp(gw, inetOk, prev, now);
  const fresh = (at: number | null): boolean => at != null && now - at <= DNS_FRESH_MS;
  const dnsSysOk = input.dnsDisabled === true || fresh(input.dnsSysOkAt);
  const dnsDirectOk = input.dnsDisabled === true || fresh(input.dnsDirectOkAt);
  return {
    now,
    hasRoute: route?.hasRoute ?? true,
    routeAt: route?.at ?? null,
    assoc: wifi?.assoc ?? null,
    selfAssigned: route?.selfAssigned ?? false,
    rssi: wifi?.rssi ?? null,
    vpn: route?.vpn ?? false,
    gwLink: gw.link,
    inetLink: inet.link,
    inetDownSince: inet.downSince,
    gwDownSince: gw.downSince,
    inetUpSince: inet.upSince,
    gwUpSince: gw.upSince,
    inetOk,
    icmpBlocked,
    ...gwNoIcmp,
    ...portal,
    hasHttpResult: http != null,
    lastHttpKind: http?.kind ?? null,
    httpAgeS: http ? (now - http.startedAt) / 1000 : null,
    httpStartedAt: http?.startedAt ?? null,
    lastHttpOkAt: okRunSince(input.captive, prev),
    dnsSysOk,
    dnsDirectOk,
    dnsOk: dnsSysOk || dnsDirectOk,
    webFailStreak: input.webFailStreak,
    heldGrade: input.heldGrade,
    ...grace,
    gapMs: input.gapMs,
  };
}
