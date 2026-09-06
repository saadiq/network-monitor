// §11 JSONL log. Pure: tickRow/metaRow. I/O: JsonlLogger (Bun FileSink, flush each tick and on close;
// a write error self-disables logging and the footer shows `log: off (CODE)`, §10).
import { closeSync, openSync } from 'node:fs';
import { LOG_VERSION } from '../config';
import { monoNow, wallNow } from '../core/clock';
import type { Cause, Grade, Snapshot, State } from '../model/types';
import type { HttpKind } from '../probes/types';
import type { LogEvent } from './events';

export type { LogEvent } from './events';

/** The subset of Bun's FileSink the logger uses (tests inject a fake). */
export interface SinkLike {
  write(chunk: string): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}

export interface LogMeta {
  argv?: string[];
  target?: string | null;
  iface?: string | null; // egress interface
  wifiIface?: string | null;
  gateway?: string | null;
  vpn?: boolean;
  startedAt?: number; // monotonic ms at process start (default: monoNow() at open)
  startedWall?: number; // epoch ms at process start (default: wallNow() at open)
}

export interface TickRow {
  kind: 'tick'; t: number; m: number; state: State; cause: Cause; grade: Grade; sat: boolean;
  gwRtt: number | null; gwLoss60: number | null; inetRtt: number | null;
  p50: number | null; p95: number | null; jitter: number | null; loss10: number | null; loss60: number | null;
  late60: number; unmeasured60: number; http: HttpKind | null; httpMs: number | null;
  dnsDirectMs: number | null; dnsSysMs: number | null; dnsOk: boolean;
  rssi: number | null; noise: number | null; txRate: number | null;
  inKBs: number | null; outKBs: number | null; loaded: boolean; icmpBlocked: boolean;
}

/** §11 tick keys in output order (frozen at v:1). */
export const TICK_KEYS: readonly (keyof TickRow)[] = [
  'kind', 't', 'm', 'state', 'cause', 'grade', 'sat', 'gwRtt', 'gwLoss60', 'inetRtt', 'p50', 'p95',
  'jitter', 'loss10', 'loss60', 'late60', 'unmeasured60', 'http', 'httpMs', 'dnsDirectMs', 'dnsSysMs',
  'dnsOk', 'rssi', 'noise', 'txRate', 'inKBs', 'outKBs', 'loaded', 'icmpBlocked',
];

/** Latest per-second RTTs (§11); the Snapshot carries no gateway sample history, so the store supplies them. */
export interface TickExtra { gwRtt?: number | null; inetRtt?: number | null }

const r1 = (x: number | null | undefined): number | null => (x == null ? null : Math.round(x * 10) / 10);

/** §11 tick row (pure). inetRtt defaults to the newest rttHistory entry (null = LOST); gwRtt to null. */
export function tickRow(snap: Snapshot, extra: TickExtra = {}): TickRow {
  const lastInet = snap.rttHistory.length ? snap.rttHistory[snap.rttHistory.length - 1] ?? null : null;
  return {
    kind: 'tick', t: snap.wall, m: Math.round(snap.now - snap.startedAt),
    state: snap.state, cause: snap.cause, grade: snap.grade.grade, sat: snap.sat,
    gwRtt: r1(extra.gwRtt), gwLoss60: snap.gw.loss60,
    inetRtt: r1(extra.inetRtt === undefined ? lastInet : extra.inetRtt),
    p50: snap.inet.p50, p95: snap.inet.p95, jitter: snap.inet.jitter,
    loss10: snap.inet.loss10, loss60: snap.inet.loss60,
    late60: snap.late60, unmeasured60: snap.unmeasured60,
    http: snap.http?.kind ?? null, httpMs: snap.http?.ms ?? null,
    dnsDirectMs: snap.dnsDirect?.ms ?? null, dnsSysMs: snap.dnsSys?.ms ?? null, dnsOk: snap.dnsOk,
    rssi: snap.wifi?.rssi ?? null, noise: snap.wifi?.noise ?? null, txRate: snap.wifi?.txRate ?? null,
    inKBs: snap.inKBs, outKBs: snap.outKBs, loaded: snap.loadedNow, icmpBlocked: snap.icmpBlocked,
  };
}

/** §11 meta row (pure). */
export function metaRow(meta: LogMeta, wall: number): Record<string, unknown> {
  return {
    kind: 'meta', v: LOG_VERSION, t: wall, m: 0, argv: meta.argv ?? [],
    iface: meta.iface ?? null, wifiIface: meta.wifiIface ?? null, gateway: meta.gateway ?? null,
    target: meta.target ?? null, vpn: meta.vpn ?? false,
  };
}

/** errno code ('EACCES', 'ENOENT', …) when present, else the message. */
export function errCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return e instanceof Error ? e.message : String(e);
}

export type OpenResult = { ok: true; logger: JsonlLogger } | { ok: false; reason: string };

/** Rows produced before the meta row (the ticks of the first second) are held, not dropped. */
const PRE_META_ROWS = 8;

export class JsonlLogger {
  private off: string | null = null; // error code once disabled
  private closed = false;
  private metaWritten = false;
  private pending: string[] = []; // rows written before the meta row, in order
  private readonly startedAt: number;
  private readonly startedWall: number;

  constructor(readonly path: string, private readonly sink: SinkLike, private readonly meta: LogMeta) {
    this.startedAt = meta.startedAt ?? monoNow();
    this.startedWall = meta.startedWall ?? wallNow();
  }

  /** Open (truncate/create) `path`, write the meta row and flush. null when the file cannot be written. */
  static async open(path: string, meta: LogMeta = {}): Promise<JsonlLogger | null> {
    const r = await JsonlLogger.tryOpen(path, meta);
    return r.ok ? r.logger : null;
  }

  /**
   * Like open(), but reports why it failed (footer `log: off (EACCES)`). The meta row is not written
   * here: it waits for writeMeta(patch) so the first route poll can fill in iface/gateway/vpn (§11).
   */
  static async tryOpen(path: string, meta: LogMeta = {}): Promise<OpenResult> {
    let sink: SinkLike;
    try {
      // create/truncate first: writer() alone overwrites in place (stale tail); Bun.write would mkdir -p
      closeSync(openSync(path, 'w'));
      sink = Bun.file(path).writer();
    } catch (e) {
      return { ok: false, reason: errCode(e) };
    }
    const logger = new JsonlLogger(path, sink, meta);
    try {
      await sink.flush();
    } catch (e) {
      logger.disable(e);
    }
    return logger.off === null ? { ok: true, logger } : { ok: false, reason: logger.off };
  }

  /** 'on', or 'off (EACCES)' once a write failed (§10). */
  get status(): string {
    return this.off === null ? 'on' : `off (${this.off})`;
  }

  get enabled(): boolean {
    return this.off === null && !this.closed;
  }

  /**
   * Write the one §11 meta row, merging in what is only known after the first route poll
   * (iface/wifiIface/gateway/vpn). Later calls are no-ops: one meta row per file. False on write error.
   */
  writeMeta(patch: Partial<LogMeta> = {}): boolean {
    if (this.metaWritten || this.off !== null) return this.metaWritten;
    Object.assign(this.meta, patch);
    this.metaWritten = true;
    if (!this.emit(`${JSON.stringify(metaRow(this.meta, this.startedWall))}\n`)) return false;
    const held = this.pending;
    this.pending = [];
    for (const line of held) if (!this.emit(line)) return false;
    this.flushSoon();
    return true;
  }

  /** One §11 tick row, then flush (once per second). */
  tick(snap: Snapshot, extra: TickExtra = {}): void {
    if (!this.enabled) return;
    if (this.writeRow(tickRow(snap, extra))) this.flushSoon();
  }

  /** One §11 event row, stamped with the given (or current) time, then flush. */
  event(e: LogEvent, now: number = monoNow(), wall: number = wallNow()): void {
    if (!this.enabled) return;
    if (this.writeRow({ kind: 'event', t: wall, m: Math.round(now - this.startedAt), ...e })) this.flushSoon();
  }

  /** Flush and close. Idempotent; the returned promise settles when the sink has ended. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.off !== null) return;
    if (!this.metaWritten) this.writeMeta(); // a run too short for a first route poll still gets its header
    try {
      await this.sink.flush();
      await this.sink.end();
    } catch (e) {
      this.disable(e);
    }
  }

  /** Serialize one row; hold it while the meta row is still pending, else append it. */
  private writeRow(row: object): boolean {
    const line = `${JSON.stringify(row)}\n`;
    if (this.metaWritten) return this.emit(line);
    this.pending.push(line);
    // never lose rows waiting for a route poll that is not coming: write the header as it stands
    return this.pending.length < PRE_META_ROWS ? true : this.writeMeta();
  }

  /** Append one line; on error self-disable and return false (never throws). */
  private emit(line: string): boolean {
    try {
      const r = this.sink.write(line);
      if (r instanceof Promise) r.catch((e: unknown) => this.disable(e));
      return true;
    } catch (e) {
      this.disable(e);
      return false;
    }
  }

  private flushSoon(): void {
    try {
      const r = this.sink.flush();
      if (r instanceof Promise) r.catch((e: unknown) => this.disable(e));
    } catch (e) {
      this.disable(e);
    }
  }

  /** Self-disable (§10): remember the code, stop writing, release the fd. */
  private disable(e: unknown): void {
    if (this.off !== null) return;
    this.off = errCode(e);
    try {
      const r = this.sink.end();
      if (r instanceof Promise) r.catch(() => {});
    } catch { /* already gone */ }
  }
}
