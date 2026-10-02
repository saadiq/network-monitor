// §8.1 hop model, shared by the PATH row (path.ts) and the simple view's chain (chain.ts):
// Wi-Fi → Router → Internet → DNS → Web, each with a mark and its detail at several lengths. Pure.
import { BIN, RSSI_WIFI_DOWN, TIP_WEAK_RSSI } from '../../config';
import { fmtMs } from '../../core/format';
import type { Aged, Snapshot } from '../../model/types';
import type { DnsResult, HttpResult } from '../../probes/types';
import type { ColorName, Glyphs } from '../ansi';
import type { Mark } from './common';

/** How much of each hop is rendered. */
export type Detail = 'full' | 'compact' | 'short' | 'abbrev';

export interface Hop {
  name: string;
  mark: Mark;
  detail: string; // full layout
  compact?: string; // compact layout (default: '' for ok/unknown, detail otherwise)
  short?: string; // tightest failure detail (default: the compact one)
  abbr?: string; // shortest name (default: name)
  color?: ColorName; // override (portal → magenta)
}

function wifiHop(snap: Snapshot, g: Glyphs): Hop | null {
  const name = 'Wi-Fi';
  if (snap.route && !snap.route.hasRoute) {
    const c = snap.state === 'NO_LINK' ? snap.cause : null;
    const detail = c === 'not-joined' ? 'not joined' : c === 'no-dhcp' ? 'no DHCP' : 'no route';
    return { name, mark: 'fail', detail, short: detail === 'no DHCP' ? detail : 'no link' };
  }
  if (snap.wifiStatus === 'off') return null; // not the egress link (e.g. Ethernet)
  if (snap.wifiStatus === 'reading') return { name, mark: 'unknown', detail: `reading${g.ellipsis}` };
  if (snap.wifiStatus === 'stale' || !snap.wifi) return { name, mark: 'unknown', detail: 'stale' };
  const wf = snap.wifi;
  if (wf.assoc === 'no') return { name, mark: 'fail', detail: 'not joined', short: 'no join' };
  if (wf.rssi == null) return { name, mark: 'ok', detail: '' };
  const dbm = `${wf.rssi}dBm`;
  if (wf.rssi < RSSI_WIFI_DOWN) return { name, mark: 'fail', detail: dbm }; // §6.2 row 4
  if (wf.rssi < TIP_WEAK_RSSI) return { name, mark: 'shaky', detail: dbm }; // §7.6 weak signal
  return { name, mark: 'ok', detail: dbm };
}

function routerHop(snap: Snapshot): Hop | null {
  const name = 'Router';
  if (!snap.route?.pingGateway) return null; // §4.1 hidden without a pingable gateway
  if (snap.gwNoIcmp) return { name, mark: 'dash', detail: 'no icmp', short: '' }; // §6.1
  const link = snap.signals.gwLink;
  if (link === 'down') return { name, mark: 'fail', detail: 'no reply', short: '' }; // the ✘ says it
  if (link === 'unknown') return { name, mark: 'unknown', detail: '' };
  return { name, mark: 'ok', detail: snap.gw.p50 == null ? '' : `${fmtMs(snap.gw.p50)}ms` };
}

function inetHop(snap: Snapshot): Hop {
  const name = 'Internet';
  const abbr = 'Inet';
  const sig = snap.signals;
  const http = snap.rttProxyMs == null ? 'http' : `http ${fmtMs(snap.rttProxyMs)}ms`;
  if (snap.icmpBlocked) { // §6.1 latch: HTTP is the authority
    return sig.inetOk
      ? { name, abbr, mark: 'ok', detail: http, compact: http, short: '' }
      : { name, abbr, mark: 'fail', detail: `http ${failWord(snap.http)}`, short: failWord(snap.http) };
  }
  if (sig.inetLink === 'down') {
    if (sig.inetOk) return { name, abbr, mark: 'ok', detail: http, compact: http, short: '' };
    const since = sig.inetDownSince == null ? snap.downFor : (snap.now - sig.inetDownSince) / 1000;
    const secs = since == null ? '' : `${Math.max(0, Math.round(since))}s`;
    return { name, abbr, mark: 'fail', detail: `no reply${secs ? ` ${secs}` : ''}`, short: secs };
  }
  if (sig.inetLink === 'unknown') {
    return sig.inetOk
      ? { name, abbr, mark: 'ok', detail: http, compact: http, short: '' }
      : { name, abbr, mark: 'unknown', detail: '' };
  }
  const ms = snap.latencyMs ?? snap.inet.p50;
  const detail = ms == null ? '' : `${fmtMs(ms)}ms`;
  const poor = sig.heldGrade === 'C' || sig.heldGrade === 'D';
  return { name, abbr, mark: poor ? 'shaky' : 'ok', detail, compact: detail, short: '' };
}

function dnsMs(r: DnsResult | null, g: Glyphs): string {
  return r?.ms == null ? g.em : fmtMs(r.ms);
}

/** §4.5 word for a round that did not answer (the 45 s window may still count the resolver ok). */
function dnsFail(r: DnsResult | null): string {
  return r?.err === 'TIMEOUT' ? 'timeout' : 'fail';
}

function dnsHop(snap: Snapshot, g: Glyphs): Hop {
  const name = 'DNS';
  if (snap.missingBins.includes(BIN.dig)) {
    return { name, mark: 'unknown', detail: 'dig: missing', compact: 'dig: missing', short: 'no dig' };
  }
  const d: Aged<DnsResult> | null = snap.dnsDirect;
  const s: Aged<DnsResult> | null = snap.dnsSys;
  if (!d && !s) return { name, mark: 'unknown', detail: '' };
  // §5 dnsOk is "a success within 45 s", so the latest round can have failed while it is still true
  const late = d && !d.ok ? `direct ${dnsFail(d)}` : s && !s.ok ? `sys ${dnsFail(s)}` : null;
  if (snap.dnsDirectOk && snap.dnsSysOk) {
    if (late) return { name, mark: 'shaky', detail: late, compact: late };
    const dm = `${dnsMs(d, g)}ms`;
    return { name, mark: 'ok', detail: `${dm} (sys ${dnsMs(s, g)})`, compact: dm, short: '' };
  }
  if (snap.dnsDirectOk) {
    return { name, mark: 'shaky', detail: d?.ok ? `${dnsMs(d, g)}ms (sys fail)` : 'sys fail', compact: 'sys fail' };
  }
  if (snap.dnsSysOk) {
    return { name, mark: 'shaky', detail: s?.ok ? `sys ${dnsMs(s, g)}ms (direct fail)` : 'direct fail', compact: 'direct fail' };
  }
  return { name, mark: 'fail', detail: '' };
}

/** curl failure word from the exit code (§4.3): connect / timeout / tls / <code> / fail. */
function failWord(h: HttpResult | null): string {
  if (!h) return 'fail';
  if (h.kind === 'dnsfail') return 'dns';
  switch (h.exitCode) {
    case 7: return 'connect';
    case 28: return 'timeout';
    case 35: case 60: return 'tls';
    case 0: return h.code == null ? 'fail' : String(h.code);
    default: return 'fail';
  }
}

function webHop(snap: Snapshot): Hop {
  const name = 'Web';
  if (snap.missingBins.includes(BIN.curl)) {
    return { name, mark: 'unknown', detail: 'curl: missing', compact: 'curl: missing', short: 'no curl' };
  }
  const h = snap.http;
  if (!h) return { name, mark: 'unknown', detail: '' };
  if (snap.httpStale) return { name, mark: 'unknown', detail: 'stale' };
  if (h.kind === 'ok') return { name, mark: 'ok', detail: h.code == null ? 'OK' : `${h.code} OK`, short: '' };
  if (h.kind === 'portal') return { name, mark: 'fail', detail: 'portal', color: 'magenta' };
  return { name, mark: 'fail', detail: failWord(h) };
}

/** The hops present for this snapshot, in path order (Wi-Fi / Router hidden when not applicable). */
export function hopList(snap: Snapshot, g: Glyphs): Hop[] {
  return [wifiHop(snap, g), routerHop(snap), inetHop(snap), dnsHop(snap, g), webHop(snap)]
    .filter((h): h is Hop => h !== null);
}

export function hopDetail(h: Hop, level: Detail): string {
  const healthy = h.mark === 'ok' || h.mark === 'unknown';
  if (level === 'full') return h.detail;
  if (level === 'compact') return h.compact ?? (healthy ? '' : h.detail);
  return h.short ?? h.compact ?? (healthy ? '' : h.detail);
}
