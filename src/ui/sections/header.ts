// §8.1 row 1: ` netmon  en1 · gw … · dns … (ts) · probes 0.4 MB   HH:MM:SS  run 18m44s`.
// Left parts are dropped from the right (probes, dns, sat, gw) until the row fits.
import { TAILSCALE_DNS } from '../../config';
import { fit, fmtBytes, fmtDuration, fmtTime, visibleWidth } from '../../core/format';
import type { Snapshot } from '../../model/types';
import { GLYPHS, color, type Glyphs } from '../ansi';

const MIN_GAP = 2;

function leftParts(snap: Snapshot, g: Glyphs): string[] {
  const r = snap.route;
  const iface = (r?.egressIface ?? g.em) + (snap.vpn ? ' vpn' : '');
  const gw = r?.pingGateway ?? r?.gateway ?? g.em;
  const dns = snap.dnsServer == null
    ? g.em
    : snap.dnsServer + (snap.dnsServer === TAILSCALE_DNS ? ' (ts)' : '');
  const parts = [iface, `gw ${gw}`];
  if (snap.sat) parts.push(`sat +${snap.rttOffset}ms`); // §7.1
  parts.push(`dns ${dns}`, `probes ${fmtBytes(snap.probeBytes)}`);
  return parts;
}

/** One row, exactly `w` cells; the clock/run block is right-aligned. */
export function header(snap: Snapshot, w: number, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const name = ' ' + color('bold', 'netmon', colorOn) + '  ';
  const parts = leftParts(snap, g);
  const right = `${fmtTime(snap.wall)}  run ${fmtDuration(snap.runS)}`;
  const rw = visibleWidth(right);
  let left = name;
  for (let n = parts.length; n >= 1; n--) {
    left = name + parts.slice(0, n).join(` ${g.sep} `);
    if (visibleWidth(left) + MIN_GAP + rw <= w) break;
  }
  const gap = Math.max(1, w - visibleWidth(left) - rw);
  return [fit(left + ' '.repeat(gap) + right, w)];
}

/** Simple view (simple-view spec §4): ` netmon  Wi-Fi (en1) · vpn`, clock right-aligned. */
export function simpleHeader(snap: Snapshot, w: number, g: Glyphs = GLYPHS.unicode, colorOn = true): string[] {
  const iface = snap.route?.egressIface ?? g.em;
  const link = snap.wifiStatus === 'off' ? iface : `Wi-Fi (${iface})`;
  const left = ' ' + color('bold', 'netmon', colorOn) + '  ' + link + (snap.vpn ? ` ${g.sep} vpn` : '');
  const right = fmtTime(snap.wall);
  const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
  return [fit(left + ' '.repeat(gap) + right, w)];
}
