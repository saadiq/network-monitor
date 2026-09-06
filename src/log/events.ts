// §11 event rows: payload types and pure builders from model/probe records.
import type { Cause, Outage, State, Transition } from '../model/types';
import type { RouteInfo, SpeedResult, WifiAssoc, WifiInfo } from '../probes/types';

export type LogEvent =
  | { event: 'transition'; from: State; to: State; cause: Cause; startedAt: number }
  | { event: 'outage'; cause: Cause; startedAt: number; endedAt: number | null; durationS: number; sleep: boolean }
  | { event: 'route'; iface: string | null; gateway: string | null; vpn: boolean }
  | { event: 'speed'; downMbps: number | null; bytes: number; ms: number | null }
  | { event: 'gap'; fromT: number; toT: number; gapS: number }
  | {
      event: 'wifi'; rssi: number | null; noise: number | null; txRate: number | null;
      mcs: number | null; channel: string | null; phy: string | null; assoc: WifiAssoc;
    };

export function transitionEvent(t: Transition): LogEvent {
  return { event: 'transition', from: t.from, to: t.to, cause: t.cause, startedAt: t.startedAt };
}

/** A closed outage (§6.3); `sleep` marks a gap-closed one. */
export function outageEvent(o: Outage): LogEvent {
  return { event: 'outage', cause: o.cause, startedAt: o.startedAt, endedAt: o.endedAt, durationS: o.durationS, sleep: o.sleep };
}

export function routeEvent(r: RouteInfo): LogEvent {
  return { event: 'route', iface: r.egressIface, gateway: r.gateway, vpn: r.vpn };
}

export function speedEvent(s: SpeedResult): LogEvent {
  return { event: 'speed', downMbps: s.downMbps, bytes: s.bytes, ms: s.ms };
}

/**
 * Sleep gap (§6.3): fromT/toT are epoch ms of the tick before and after the gap. The store derives
 * fromT by float arithmetic (wall − elapsed), so both ends are rounded: §11 timestamps are whole ms.
 */
export function gapEvent(fromT: number, toT: number): LogEvent {
  const from = Math.round(fromT);
  const to = Math.round(toT);
  return { event: 'gap', fromT: from, toT: to, gapS: Math.round((to - from) / 1000) };
}

export function wifiEvent(w: WifiInfo): LogEvent {
  return {
    event: 'wifi', rssi: w.rssi, noise: w.noise, txRate: w.txRate, mcs: w.mcs,
    channel: w.channel, phy: w.phy, assoc: w.assoc,
  };
}
