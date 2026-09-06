// Wires the pollers and the two ping streams to the Store (§4, §10). Side-effecting: owns the
// child processes through the pollers/streams; a missing binary (preflight) disables its probe.
import { BIN, HTTP_CADENCE_MS, HTTP_FAST_CADENCE_MS } from '../config';
import type { Options } from '../cli/types';
import type { StreamHealth, Store } from '../model/store';
import { isOffline, type LinkState, type Snapshot, type Transition } from '../model/types';
import { CounterPoller } from '../probes/counters';
import { DnsPoller } from '../probes/dns';
import { HttpPoller } from '../probes/http';
import { HttpsPoller } from '../probes/https';
import { PingStream } from '../probes/ping-stream';
import { RoutePoller } from '../probes/route';
import type { HttpResult, RouteInfo, Timed, WifiInfo } from '../probes/types';
import { WifiPoller } from '../probes/wifi';

/** Side channels for main (logging, plain-mode events); the store is fed directly. */
export interface ProbeHooks {
  onRoute?(info: RouteInfo): void;
  onHttp?(r: HttpResult): void;
  onWifi?(w: Timed<WifiInfo>): void;
  /** §12: `--iface` named an interface that is not the egress, so it is being ignored. Once. */
  onIfaceIgnored?(iface: string, egress: string | null): void;
}

const leavesOutage = (t: Transition): boolean =>
  (t.from === 'PORTAL' || t.from === 'DOWN') && t.to !== 'PORTAL' && t.to !== 'DOWN';

/**
 * §4.1.5: the interface the Wi-Fi poller should read, or null to pause it. Wi-Fi is polled when
 * it is the egress, under a VPN, and — §6.2 row 1 — whenever there is no route at all: that is
 * exactly when the state machine needs `assoc` to say `not-joined` vs `no-dhcp`. Only a live
 * non-Wi-Fi egress (Ethernet) pauses it, because then the radio is not what we are measuring.
 */
export function wifiPollIface(info: RouteInfo): string | null {
  if (info.wifiIface === null) return null;
  return !info.hasRoute || info.egressIface === info.wifiIface || info.vpn ? info.wifiIface : null;
}

/** §12: `--iface X` while a live non-VPN route egresses elsewhere — the override is inert. */
export function ifaceIgnored(info: RouteInfo, iface: string | null): boolean {
  return iface !== null && info.wifiIface !== null && wifiPollIface(info) === null;
}

export class Probes {
  readonly inet: PingStream | null;
  readonly gw: PingStream | null;
  readonly route: RoutePoller | null;
  readonly counters: CounterPoller | null;
  readonly wifi: WifiPoller | null;
  readonly http: HttpPoller | null;
  readonly https: HttpsPoller | null;
  readonly dns: DnsPoller | null;
  private gwTarget: string | null = null;
  private prevInetLink: LinkState = 'unknown';
  private saidIfaceIgnored = false;

  constructor(
    private readonly store: Store,
    private readonly opts: Options,
    missing: Set<string>,
    private readonly hooks: ProbeHooks = {},
  ) {
    const has = (bin: string): boolean => !missing.has(bin);
    this.inet = has(BIN.ping) ? new PingStream() : null;
    this.gw = has(BIN.ping) ? new PingStream() : null;
    this.route = has(BIN.route) ? new RoutePoller({ target: opts.target, iface: opts.iface }) : null;
    this.counters = has(BIN.netstat) ? new CounterPoller() : null;
    this.wifi = has(BIN.system_profiler) ? new WifiPoller() : null;
    this.http = has(BIN.curl) ? new HttpPoller() : null;
    this.https = has(BIN.curl) ? new HttpsPoller() : null;
    this.dns = has(BIN.dig) ? new DnsPoller() : null;
  }

  start(): void {
    this.inet?.onEvent((e, at, gen) => this.store.onPingEvent('inet', e, at, gen));
    this.gw?.onEvent((e, at, gen) => this.store.onPingEvent('gw', e, at, gen));
    this.inet?.start(this.opts.target);
    // the gateway stream waits for a pingGateway (§10)
    this.route?.start((info) => this.handleRoute(info));
    this.counters?.start((sample, totals) => this.store.onCounters(sample, totals));
    this.wifi?.start(null, (w) => {
      this.store.onWifi(w);
      this.hooks.onWifi?.(w);
    });
    this.http?.start((r) => {
      this.store.onHttp(r);
      this.hooks.onHttp?.(r);
      this.maybeHttpsCheck(r);
    });
    this.https?.start((r) => this.store.onHttps(r));
    this.dns?.start((pair) => this.store.onDns(pair));
  }

  stop(): void {
    this.inet?.stop();
    this.gw?.stop();
    this.route?.stop();
    this.counters?.stop();
    this.wifi?.stop();
    this.http?.stop();
    this.https?.stop();
    this.dns?.stop();
  }

  health(now: number): StreamHealth {
    return {
      inetStalled: this.inet?.stalled(now) ?? true,
      gwStalled: this.gw?.stalled(now) ?? true,
      gwActive: this.gw?.isRunning ?? false,
    };
  }

  /** §6.3 sleep gap: restart both streams (generation bump → pending seqs UNMEASURED). */
  onGap(): void {
    for (const s of [this.inet, this.gw]) if (s?.isRunning && s.target) s.retarget(s.target);
  }

  /** Per tick, after the snapshot: route/captive cadences and out-of-band checks (§4.1, §4.3, §4.4, §6.2). */
  adjust(snap: Snapshot, transitions: Transition[]): void {
    const sig = snap.signals;
    this.route?.setFast(snap.state === 'NO_LINK' || sig.gwLink === 'down');
    if (this.http) {
      const fast = isOffline(snap.state) || (sig.inetLink === 'down' && !sig.icmpBlocked);
      this.http.setCadence(fast ? HTTP_FAST_CADENCE_MS : HTTP_CADENCE_MS);
      if (sig.inetLink === 'down' && this.prevInetLink !== 'down') this.http.triggerNow(); // §6.2 confirmation
    }
    if (transitions.some(leavesOutage)) this.https?.triggerNow(); // §4.4
    this.prevInetLink = sig.inetLink;
  }

  /** §4.4: captive ok while the inet stream is down and both resolvers fail → HTTPS cross-check. */
  private maybeHttpsCheck(r: HttpResult): void {
    const sig = this.store.sig;
    if (r.kind === 'ok' && sig.inetLink === 'down' && !sig.dnsSysOk && !sig.dnsDirectOk) this.https?.triggerNow();
  }

  /** §4.1: retarget the gateway stream, and point counters / Wi-Fi at the right interface. */
  private handleRoute(info: RouteInfo): void {
    this.store.onRoute(info);
    if (info.pingGateway !== this.gwTarget) {
      this.gwTarget = info.pingGateway;
      if (info.pingGateway) this.gw?.start(info.pingGateway); // start() retargets when already running
      else this.gw?.stop();
    }
    this.counters?.setIface(info.hasRoute ? (info.vpn ? info.wifiIface : info.egressIface) : null); // §4.1.5
    const wifiIface = wifiPollIface(info);
    this.wifi?.setIface(wifiIface);
    this.store.setWifiEnabled(this.wifi !== null && wifiIface !== null);
    if (!this.saidIfaceIgnored && this.opts.iface && ifaceIgnored(info, this.opts.iface)) {
      this.saidIfaceIgnored = true; // §12: say it once, not every route poll
      this.hooks.onIfaceIgnored?.(this.opts.iface, info.egressIface);
    }
    this.hooks.onRoute?.(info);
  }
}
