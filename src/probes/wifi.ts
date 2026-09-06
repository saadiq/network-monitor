// §4.6 Wi-Fi radio: parseAirportJson (pure) + WifiPoller (system_profiler via run()).
import {
  BIN, SNR_FAIR, SNR_GOOD, WIFI_BACKOFF_MS, WIFI_CADENCE_MS, WIFI_FAILS_BEFORE_BACKOFF, WIFI_KILL_MS,
} from '../config';
import { monoNow } from '../core/clock';
import type { SnrLabel, Timed, WifiInfo } from './types';
import { PollLoop } from './poll-loop';
import { defaultRun, type RunFn } from './runner';

// `-nospawn` keeps the work in this process: without it system_profiler forks a
// `-nospawn -xml … -detailLevel full` helper that run()'s SIGTERM/SIGKILL and killAll() cannot
// reach (it is reparented to launchd and outlives netmon). §4.6
export const AIRPORT_ARGV: readonly string[] =
  [BIN.system_profiler, '-nospawn', '-json', 'SPAirPortDataType', '-detailLevel', 'basic'];

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** good ≥ 25, fair 15–24, poor < 15 (§4.6). */
export function snrLabel(snr: number): SnrLabel {
  return snr >= SNR_GOOD ? 'good' : snr >= SNR_FAIR ? 'fair' : 'poor';
}

/** The interface block with `_name === iface` (awdl0 also carries a network block, §4.6). */
function findInterface(json: string, iface: string): Dict | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isDict(root) || !Array.isArray(root.SPAirPortDataType)) return null;
  const first: unknown = root.SPAirPortDataType[0];
  if (!isDict(first) || !Array.isArray(first.spairport_airport_interfaces)) return null;
  const hit: unknown = first.spairport_airport_interfaces.find((i: unknown) => isDict(i) && i._name === iface);
  return isDict(hit) ? hit : null;
}

/** §4.6. null when the JSON is unusable or iface is absent; assoc 'no' with null fields when not joined. */
export function parseAirportJson(json: string, iface: string): WifiInfo | null {
  const ifc = findInterface(json, iface);
  if (ifc === null) return null;
  const cni = isDict(ifc.spairport_current_network_information) ? ifc.spairport_current_network_information : null;
  const assoc = cni !== null && ifc.spairport_status_information === 'spairport_status_connected' ? 'yes' : 'no';
  const info: WifiInfo = {
    iface, assoc, ssid: null, rssi: null, noise: null, snr: null, label: null, txRate: null, mcs: null, channel: null, phy: null,
  };
  if (cni === null) return info;
  const sn = /(-?\d+) dBm \/ (-?\d+) dBm/.exec(str(cni.spairport_signal_noise) ?? '');
  const rssi = sn ? Number(sn[1]) : null;
  const noise = sn ? Number(sn[2]) : null;
  const snr = rssi !== null && noise !== null ? rssi - noise : null;
  const name = str(cni._name);
  return {
    ...info,
    ssid: name === '<redacted>' ? null : name,
    rssi, noise, snr,
    label: snr === null ? null : snrLabel(snr),
    txRate: num(cni.spairport_network_rate),
    mcs: num(cni.spairport_network_mcs),
    channel: str(cni.spairport_network_channel),
    phy: str(cni.spairport_network_phymode),
  };
}

export interface WifiPollerOpts {
  run?: RunFn;
  now?: () => number;
}

export type WifiHandler = (info: Timed<WifiInfo>) => void;

/**
 * system_profiler every 60 s, killed at WIFI_KILL_MS, single-flight; 3 consecutive failures →
 * 120 s (§4.6). Runs only while an iface is set — the integrator passes null when a non-Wi-Fi
 * egress is active (§4.1.5). `at` = completion time (when the reading was actually produced).
 */
export class WifiPoller {
  private readonly run: RunFn;
  private readonly now: () => number;
  private readonly loop: PollLoop;
  private onInfo: WifiHandler | null = null;
  private iface: string | null = null;
  private started = false;
  private fails = 0;
  /** Most recent successful reading. */
  last: Timed<WifiInfo> | null = null;

  constructor(opts: WifiPollerOpts = {}) {
    this.run = opts.run ?? defaultRun;
    this.now = opts.now ?? monoNow;
    this.loop = new PollLoop(() => this.poll(), this.now);
  }

  get failures(): number {
    return this.fails;
  }

  get cadenceMs(): number {
    return this.fails >= WIFI_FAILS_BEFORE_BACKOFF ? WIFI_BACKOFF_MS : WIFI_CADENCE_MS;
  }

  /** Polls immediately when iface is non-null; otherwise waits for setIface. */
  start(iface: string | null, onInfo: WifiHandler): void {
    this.onInfo = onInfo;
    this.started = true;
    this.iface = iface;
    if (iface !== null) this.loop.schedule(0);
  }

  /** null pauses polling; a new iface polls at once (an in-flight result for the old one is dropped). */
  setIface(iface: string | null): void {
    if (iface === this.iface) return;
    this.iface = iface;
    this.fails = 0;
    if (iface === null) {
      this.loop.cancel();
      return;
    }
    if (this.started && !this.loop.inFlight) this.loop.schedule(0);
  }

  stop(): void {
    this.loop.stop();
  }

  /** One run; null when idle, killed, unparseable, or retargeted mid-flight. */
  async pollOnce(): Promise<Timed<WifiInfo> | null> {
    const iface = this.iface;
    if (iface === null) return null;
    const r = await this.run([...AIRPORT_ARGV], WIFI_KILL_MS);
    const at = this.now(); // stamped at completion: the reading is fresh, not ~13 s old
    if (iface !== this.iface) return null;
    const parsed = r.ok ? parseAirportJson(r.stdout, iface) : null;
    if (parsed === null) {
      this.fails++;
      return null;
    }
    this.fails = 0;
    const info: Timed<WifiInfo> = { ...parsed, at };
    this.last = info;
    if (!this.loop.stopped) this.onInfo?.(info);
    return info;
  }

  private async poll(): Promise<number | null> {
    const iface = this.iface;
    await this.pollOnce();
    if (this.iface === null) return null;
    return this.iface === iface ? this.cadenceMs : 0;
  }
}
