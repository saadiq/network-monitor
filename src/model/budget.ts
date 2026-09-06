// §4.10 probe data budget. Pure accumulator; the store calls add() per probe result.
import { DNS_CADENCE_MS, HTTPS_CADENCE_MS, HTTP_CADENCE_MS, PING_INTERVAL_MS, PROBE_BYTES } from '../config';

export type BudgetKind = 'ping' | 'dns' | 'captive' | 'https' | 'speed';

const HOUR_MS = 3_600_000;

/** §4.10 baseline: 2 ping streams + dig pair / 15 s + captive / 10 s + HTTPS / 180 s ≈ 1.17 MB/h. */
export const BASELINE_BYTES_PER_HOUR = Math.round(
  2 * PROBE_BYTES.ping * (HOUR_MS / PING_INTERVAL_MS)
  + PROBE_BYTES.dns * (HOUR_MS / DNS_CADENCE_MS)
  + PROBE_BYTES.captive * (HOUR_MS / HTTP_CADENCE_MS)
  + PROBE_BYTES.https * (HOUR_MS / HTTPS_CADENCE_MS),
);

/** Bytes charged for one probe: config default, or `bytes` when given; speed = size_download + overhead. */
export function probeCost(kind: BudgetKind, bytes?: number): number {
  if (kind === 'speed') return Math.max(0, bytes ?? 0) + PROBE_BYTES.speedOverhead;
  return bytes ?? PROBE_BYTES[kind];
}

export class Budget {
  private bytes = 0;
  private speed = 0;
  readonly counts: Record<BudgetKind, number> = { ping: 0, dns: 0, captive: 0, https: 0, speed: 0 };

  /** Charge one probe; returns the bytes added. */
  add(kind: BudgetKind, bytes?: number): number {
    const n = probeCost(kind, bytes);
    this.bytes += n;
    if (kind === 'speed') this.speed += n;
    this.counts[kind] += 1;
    return n;
  }

  /** Session total, both directions (Snapshot.probeBytes). */
  get total(): number {
    return this.bytes;
  }

  /** Bytes spent on speed tests this session (incl. overhead). */
  get speedBytes(): number {
    return this.speed;
  }

  /**
   * Footer `probes ~1.2 MB/h`: the steady probe cadence (§4.10 baseline, Snapshot.probeRateEst).
   * Speed-test bytes are one-offs, not a rate: they are counted in `total` / `speedBytes`.
   */
  get perHourEstimate(): number {
    return BASELINE_BYTES_PER_HOUR;
  }

  /** Measured bytes/hour from the session total; null until a minute has run. */
  observedPerHour(runS: number): number | null {
    if (runS < 60) return null;
    return (this.bytes / runS) * 3600;
  }
}
