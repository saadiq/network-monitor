// Scripted-sequence harness for signals + status tests (§6). Not a test file.
import { deriveSignals, type SignalInputs, type StreamLink } from '../src/model/signals';
import { StatusMachine } from '../src/model/status';
import type { HttpDetector, HttpKind, HttpResult, HttpsKind, HttpsResult, RouteInfo, Timed, WifiInfo } from '../src/probes/types';
import type { Signals, Transition } from '../src/model/types';

export const WALL0 = 1_757_168_000_000;

export function link(state: StreamLink['link'], over: Partial<StreamLink> = {}): StreamLink {
  return { link: state, downSince: null, upSince: null, lastReceivedAt: null, ...over };
}

export function route(over: Partial<RouteInfo> = {}): RouteInfo {
  return {
    hasRoute: true, egressIface: 'en1', wifiIface: 'en1', gateway: '192.168.0.1', pingGateway: '192.168.0.1',
    ipv4: '192.168.0.10', selfAssigned: false, vpn: false, at: 0, ...over,
  };
}

export function http(kind: HttpKind, startedAt: number, over: Partial<HttpResult> = {}): HttpResult {
  const detector: HttpDetector = over.detector ?? 'apple';
  return {
    kind, detector, url: `http://${detector}`, code: kind === 'ok' ? 200 : null, exitCode: 0,
    startedAt, ms: 300, connectMs: 120, redirectUrl: null, ...over,
  };
}

export function https(kind: HttpsKind, startedAt: number): HttpsResult {
  return { kind, code: kind === 'ok' ? 200 : null, exitCode: 0, startedAt, ms: 400 };
}

export function wifi(rssi: number | null, assoc: 'yes' | 'no', at: number): Timed<WifiInfo> {
  return {
    iface: 'en1', assoc, ssid: 'plane', rssi, noise: -95, snr: rssi == null ? null : rssi + 95, label: 'fair',
    txRate: 216, mcs: 4, channel: '157', phy: '802.11ax', at,
  };
}

export type Over = Partial<Omit<SignalInputs, 'prev'>>;

/** Drives deriveSignals + StatusMachine one 1 s tick at a time. */
export class Sim {
  now: number;
  prev: Signals | null = null;
  sig!: Signals;
  readonly sm: StatusMachine;
  readonly transitions: Transition[] = [];

  constructor(startNow = 0) {
    this.now = startNow;
    this.sm = new StatusMachine(startNow, WALL0 + startNow);
  }

  inputs(over: Over): SignalInputs {
    return {
      gw: link('up'), inet: link('up'), captive: [], https: null, webFailStreak: 0,
      dnsSysOkAt: this.now, dnsDirectOkAt: this.now, route: route(), wifi: null, heldGrade: 'A', gapMs: 1000,
      ...over, prev: this.prev,
    };
  }

  /** Advance one tick and return the confirmed transition, if any. */
  step(over: Over = {}): Transition | null {
    this.now += 1000;
    this.sig = deriveSignals(this.inputs(over), this.now);
    this.prev = this.sig;
    const t = this.sm.tick(this.sig, this.now, WALL0 + this.now);
    if (t) this.transitions.push(t);
    return t;
  }

  run(n: number, over: Over = {}): Transition[] {
    const out: Transition[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.step(over);
      if (t) out.push(t);
    }
    return out;
  }
}
