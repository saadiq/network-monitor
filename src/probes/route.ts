// §4.1 route / interface discovery: pure parsers + RoutePoller (I/O through run()).
import {
  BIN, DEFAULT_TARGET, HWPORTS_TIMEOUT_MS, ROUTE_CADENCE_MS, ROUTE_FAST_CADENCE_MS, ROUTE_TIMEOUT_MS,
} from '../config';
import { monoNow } from '../core/clock';
import type { RouteInfo } from './types';
import { PollLoop } from './poll-loop';
import { defaultRun, type RunFn } from './runner';

export interface RouteGet {
  hasRoute: boolean;
  gateway: string | null;
  egressIface: string | null;
}

const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;
const UTUN_RE = /^utun\d+$/;

export function isIPv4(s: string | null): s is string {
  return s !== null && IPV4_RE.test(s);
}

/** §4.1.1 `route -n get <target>`; pass stdout + stderr. No interface line also means no route. */
export function parseRouteGet(s: string): RouteGet {
  if (/not in table/.test(s)) return { hasRoute: false, gateway: null, egressIface: null };
  const gateway = /^\s*gateway:\s*(\S+)/m.exec(s)?.[1] ?? null;
  const egressIface = /^\s*interface:\s*(\S+)/m.exec(s)?.[1] ?? null;
  return { hasRoute: egressIface !== null, gateway, egressIface };
}

/** §4.1.2 `networksetup -listallhardwareports` → { 'Wi-Fi': 'en1', Ethernet: 'en0', … }. */
export function parseHardwarePorts(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let port: string | null = null;
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    const p = /^Hardware Port:\s*(.+)$/.exec(line);
    if (p?.[1] !== undefined) {
      port = p[1].trim();
      continue;
    }
    const d = /^Device:\s*(\S+)/.exec(line);
    if (d?.[1] !== undefined && port !== null) {
      out[port] = d[1];
      port = null;
    }
  }
  return out;
}

/** The Wi-Fi device from a port map (`Wi-Fi`, or `AirPort` on older systems). */
export function wifiIfaceFromPorts(ports: Record<string, string>): string | null {
  for (const [name, dev] of Object.entries(ports)) {
    if (/^(wi-?fi|airport)$/i.test(name)) return dev;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** §4.1.3 `scutil --nwi`: the IPv4 address of iface inside the IPv4 block. */
export function parseNwiAddress(s: string, iface: string): string | null {
  const start = s.indexOf('IPv4 network interface information');
  if (start < 0) return null;
  let block = s.slice(start);
  const end = block.indexOf('IPv6 network interface information');
  if (end >= 0) block = block.slice(0, end);
  const lines = block.split('\n');
  const head = new RegExp(`^\\s+${escapeRe(iface)} : flags`);
  const i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (/^\s+\S+ : flags/.test(line)) break; // next interface
    const m = /address\s*:\s*(\S+)/.exec(line);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** §4.1.4 `ipconfig getoption <wifiIface> router` → dotted quad or null. */
export function parseIpconfigRouter(s: string): string | null {
  const t = s.trim();
  return IPV4_RE.test(t) ? t : null;
}

export interface RoutePollerOpts {
  target?: string; // --target (default 1.1.1.1)
  iface?: string | null; // --iface override for wifiIface (skips networksetup)
  run?: RunFn; // injected for tests; defaults to core/proc run
  now?: () => number; // monotonic clock; defaults to monoNow
}

export type RouteHandler = (info: RouteInfo) => void;

/**
 * Polls every 5 s (2 s in fast mode, §4.1) and emits a RouteInfo on every poll —
 * the store diffs `pingGateway`/`egressIface` for retargeting. Single-flight.
 */
export class RoutePoller {
  private readonly run: RunFn;
  private readonly now: () => number;
  private readonly target: string;
  private readonly ifaceOverride: string | null;
  private readonly loop: PollLoop;
  private onInfo: RouteHandler | null = null;
  private fast = false;
  private wifiIface: string | null;
  /** Egress the hardware-port table was last read for; undefined = never read. */
  private portsFor: string | null | undefined = undefined;
  /** Most recent RouteInfo (null before the first poll). */
  last: RouteInfo | null = null;

  constructor(opts: RoutePollerOpts = {}) {
    this.run = opts.run ?? defaultRun;
    this.now = opts.now ?? monoNow;
    this.target = opts.target ?? DEFAULT_TARGET;
    this.ifaceOverride = opts.iface ?? null;
    this.wifiIface = this.ifaceOverride;
    this.loop = new PollLoop(() => this.poll(), this.now);
  }

  get cadenceMs(): number {
    return this.fast ? ROUTE_FAST_CADENCE_MS : ROUTE_CADENCE_MS;
  }

  /** First poll runs immediately. */
  start(onInfo: RouteHandler): void {
    this.onInfo = onInfo;
    this.loop.schedule(0);
  }

  /** 2 s cadence while NO_LINK or gateway link down (§4.1); reschedules the pending poll. */
  setFast(fast: boolean): void {
    if (fast === this.fast) return;
    this.fast = fast;
    if (this.loop.started && !this.loop.inFlight) this.loop.scheduleFrom(this.cadenceMs);
  }

  stop(): void {
    this.loop.stop();
  }

  /** One full probe (route → ports → nwi → ipconfig); emits via onInfo unless stopped. */
  async pollOnce(): Promise<RouteInfo> {
    const at = this.now();
    const rg = await this.run([BIN.route, '-n', 'get', this.target], ROUTE_TIMEOUT_MS);
    const parsed = parseRouteGet(`${rg.stdout}\n${rg.stderr}`);
    const hasRoute = rg.ok && parsed.hasRoute;
    const egressIface = hasRoute ? parsed.egressIface : null;
    const gateway = hasRoute ? parsed.gateway : null;
    await this.refreshWifiIface(egressIface);
    const wifiIface = this.wifiIface;
    const ipv4 = wifiIface !== null ? await this.readIpv4(wifiIface) : null;
    const vpn = egressIface !== null && UTUN_RE.test(egressIface);
    let pingGateway: string | null = null;
    if (vpn) pingGateway = wifiIface !== null ? await this.readDhcpRouter(wifiIface) : null;
    else if (isIPv4(gateway)) pingGateway = gateway;
    const info: RouteInfo = {
      hasRoute, egressIface, wifiIface, gateway, pingGateway, ipv4,
      selfAssigned: ipv4?.startsWith('169.254.') ?? false, vpn, at,
    };
    this.last = info;
    if (!this.loop.stopped) this.onInfo?.(info);
    return info;
  }

  private async poll(): Promise<number> {
    await this.pollOnce();
    return this.cadenceMs;
  }

  /** networksetup at startup and whenever egress changes (§4.1.2); retried after a failure. */
  private async refreshWifiIface(egress: string | null): Promise<void> {
    if (this.ifaceOverride !== null || this.portsFor === egress) return;
    const r = await this.run([BIN.networksetup, '-listallhardwareports'], HWPORTS_TIMEOUT_MS);
    if (!r.ok) return;
    this.wifiIface = wifiIfaceFromPorts(parseHardwarePorts(r.stdout));
    this.portsFor = egress;
  }

  private async readIpv4(iface: string): Promise<string | null> {
    const r = await this.run([BIN.scutil, '--nwi'], ROUTE_TIMEOUT_MS);
    return r.ok ? parseNwiAddress(r.stdout, iface) : null;
  }

  private async readDhcpRouter(iface: string): Promise<string | null> {
    const r = await this.run([BIN.ipconfig, 'getoption', iface, 'router'], ROUTE_TIMEOUT_MS);
    return r.ok ? parseIpconfigRouter(r.stdout) : null;
  }
}
