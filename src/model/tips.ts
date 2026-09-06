// §7.6 tips: highest applicable one-liner, or null (row blank). Pure.
import {
  SAT_OFFSET_BASE_MS, TAILSCALE_DNS, TIP_DNS_SLOW_MS, TIP_DNS_SLOW_RATIO, TIP_PORTAL_OUTAGES,
  TIP_PORTAL_WINDOW_MS, TIP_WEAK_RSSI,
} from '../config';
import { GLYPHS, type Glyphs } from '../ui/ansi';
import type { Snapshot } from './types';

/** RSSI from a fresh Wi-Fi reading only (not stale/off/reading). */
function freshRssi(snap: Snapshot): number | null {
  return snap.wifiStatus === 'ok' ? snap.wifi?.rssi ?? null : null;
}

/** `Tailscale DNS is 12x slower than direct (380 vs 31ms) — …` */
function slowDnsTip(snap: Snapshot, em: string): string | null {
  const sys = snap.dnsSys;
  const dir = snap.dnsDirect;
  if (!snap.dnsSysOk || !snap.dnsDirectOk || !sys?.ok || !dir?.ok) return null;
  if (sys.ms == null || dir.ms == null) return null;
  const ratio = sys.ms / Math.max(1, dir.ms);
  if (ratio < TIP_DNS_SLOW_RATIO || sys.ms <= TIP_DNS_SLOW_MS) return null;
  const ts = snap.dnsServer === TAILSCALE_DNS;
  const name = ts ? 'Tailscale DNS' : 'system DNS';
  const tail = ts ? '; consider pausing it.' : '.';
  return `${name} is ${Math.round(ratio)}x slower than direct (${Math.round(sys.ms)} vs ${Math.round(dir.ms)}ms) ${em} pages feel slow${tail}`;
}

/** `system DNS (Tailscale 100.100.100.100) failing; direct DNS works — Tailscale, not the plane` */
function sysDnsFailingTip(snap: Snapshot, em: string): string {
  const srv = snap.dnsServer;
  const ts = srv === TAILSCALE_DNS;
  const who = srv == null ? '' : ` (${ts ? `Tailscale ${srv}` : srv})`;
  return `system DNS${who} failing; direct DNS works ${em} ${ts ? 'Tailscale' : 'the resolver'}, not the plane`;
}

/** `traffic exits via utun9 (Tailscale exit node) — measurements go through the tunnel` */
function vpnTip(snap: Snapshot, em: string): string {
  const iface = snap.route?.egressIface ?? 'a tunnel';
  const kind = snap.dnsServer === TAILSCALE_DNS ? 'Tailscale exit node' : 'VPN';
  return `traffic exits via ${iface} (${kind}) ${em} measurements go through the tunnel`;
}

/** `portal logs you out every ~12m — keep the login tab open` (≥ 2 portal outages in 30 min). */
function portalCycleTip(snap: Snapshot, em: string): string | null {
  const cutoff = snap.wall - TIP_PORTAL_WINDOW_MS;
  const starts = snap.outages
    .filter((o) => (o.cause === 'portal' || o.state === 'PORTAL') && !o.sleep && o.startedAt >= cutoff)
    .map((o) => o.startedAt)
    .sort((a, b) => a - b);
  const first = starts[0];
  const last = starts[starts.length - 1];
  if (starts.length < TIP_PORTAL_OUTAGES || first == null || last == null) return null;
  const everyMin = Math.max(1, Math.round((last - first) / (starts.length - 1) / 60_000));
  return `portal logs you out every ~${everyMin}m ${em} keep the login tab open`;
}

/** §7.6 priority list; null when nothing applies. */
export function pickTip(snap: Snapshot, g: Glyphs = GLYPHS.unicode): string | null {
  const em = g.em;
  if (snap.state === 'PORTAL') return 'press o to open the login page';
  if (snap.state === 'NO_LINK' && snap.cause === 'no-dhcp') {
    return `no address from the router yet (DHCP) ${em} wait ~30s, then re-join Wi-Fi`;
  }
  const rssi = freshRssi(snap);
  if (rssi != null && rssi < TIP_WEAK_RSSI) return `weak signal ${rssi} dBm ${em} move the laptop; it may just be the seat`;
  if (snap.icmpBlocked) return `airline blocks ping ${em} judging by HTTP checks, latency is coarse`;
  if (snap.gwNoIcmp) return `router ignores ping ${em} local link judged by internet checks`;
  const slow = slowDnsTip(snap, em);
  if (slow) return slow;
  if (!snap.dnsSysOk && snap.dnsDirectOk) return sysDnsFailingTip(snap, em);
  if (snap.vpn) return vpnTip(snap, em);
  const portal = portalCycleTip(snap, em);
  if (portal) return portal;
  if (snap.sat) return `satellite link: ~${snap.rttOffset + SAT_OFFSET_BASE_MS}ms is normal here; thresholds adjusted`;
  if (snap.grade.underLoad) return `your own traffic is loading the link ${em} numbers marked ~`;
  return null;
}
