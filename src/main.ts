// Entry (§13): parseArgs → preflight → Store + probes + ticker → TUI or plain → idempotent shutdown.
// The only module that touches every side-effecting package.
import { bellAction, FOOTER_MSG_MS, portalAction, speedAction, type ActionCtx } from './app/actions';
import { Probes } from './app/probes';
import { drawTui } from './app/render';
import { Alerter } from './actions/alerts';
import { ArgsError, parseArgs, usage } from './cli/args';
import type { Options } from './cli/types';
import { ALL_BINS, FLASH_TICKS, TICK_MS } from './config';
import { monoNow, Ticker, wallNow } from './core/clock';
import { killAll, preflight } from './core/proc';
import { gapEvent, outageEvent, routeEvent, transitionEvent, wifiEvent } from './log/events';
import { JsonlLogger } from './log/jsonl';
import { Store } from './model/store';
import { quitReport } from './model/summary';
import type { Snapshot, UiState } from './model/types';
import { glyphs } from './ui/ansi';
import { bindKeys } from './ui/keys';
import { renderPlainEvent, renderPlainLine } from './ui/plain';
import { installShutdownHandlers, onShutdown, shutdown, Tty } from './ui/tty';

function parseOrExit(argv: string[]): Options {
  try {
    return parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgsError) {
      process.stderr.write(`${e.message}\n\n${usage()}`);
      process.exit(2);
    }
    throw e;
  }
}

/** Plain-mode stdout. A reader that went away (`netmon --plain | head -3`) ends the run (§8.5, §10). */
interface Out { line(s: string): void; alive(): boolean }

function stdoutSink(): Out {
  let alive = true;
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    alive = false;
    if (e.code === 'EPIPE') shutdown('stdout closed'); // nobody is reading: stop the ticker and the probes
    else shutdown('stdout error', 1, e);
  });
  return {
    line(s: string): void {
      if (!alive) return;
      try {
        process.stdout.write(`${s}\n`);
      } catch {
        alive = false; // the 'error' listener above starts the shutdown
      }
    },
    alive: () => alive,
  };
}

async function openLogger(opts: Options, startedAt: number, startedWall: number, ui: UiState): Promise<JsonlLogger | null> {
  if (!opts.log) return null;
  const r = await JsonlLogger.tryOpen(opts.log, {
    argv: process.argv.slice(2), target: opts.target, startedAt, startedWall,
  });
  ui.logStatus = r.ok ? 'on' : `off (${r.reason})`;
  return r.ok ? r.logger : null;
}

/** §12: `--iface X` is inert when X is not the egress — say so once, where the user can see it. */
function ifaceNotice(tui: boolean, ui: UiState, iface: string, egress: string | null): void {
  const msg = `--iface ${iface} is not the egress (${egress ?? 'none'})`;
  if (tui) {
    ui.footerMsg = msg;
    ui.footerMsgUntil = monoNow() + FOOTER_MSG_MS;
    return;
  }
  try {
    process.stderr.write(`netmon: ${msg}\n`);
  } catch { /* stderr gone (SIGHUP) */ }
}

/** §10: outside the TUI there is no footer, so a log that is off says so once on stderr. */
function logNotice(tui: boolean, status: string | null, path: string | null): void {
  if (tui || !path || status === null || status === 'on') return;
  try {
    process.stderr.write(`netmon: log ${status}: ${path}\n`);
  } catch { /* stderr gone (SIGHUP) */ }
}

function wireShutdown(ticker: Ticker, probes: Probes, logger: JsonlLogger | null, report: () => void): void {
  onShutdown(() => ticker.stop());
  onShutdown(() => probes.stop());
  onShutdown(() => killAll());
  onShutdown(() => {
    if (logger) void logger.close();
  });
  onShutdown(report); // §8.6, after the alt screen is gone
}

function enterTui(tty: Tty, ctx: ActionCtx): void {
  tty.enter({ onResize: () => ctx.redraw() });
  bindKeys(tty, {
    quit: () => shutdown('quit'),
    speed: () => void speedAction(ctx),
    bell: () => bellAction(ctx),
    portal: () => void portalAction(ctx),
  });
}

export async function main(): Promise<void> {
  const opts = parseOrExit(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  installShutdownHandlers(); // §8.3: signals / uncaught errors bound before any probe starts
  const out = stdoutSink();
  const missing = await preflight([...ALL_BINS]);
  const startedAt = monoNow();
  const startedWall = wallNow();
  const store = new Store({ target: opts.target, now: startedAt, wall: startedWall, ascii: opts.ascii, missingBins: [...missing] });
  const ui: UiState = {
    bellOn: opts.bell, flashTicksLeft: 0, footerMsg: null, footerMsgUntil: null,
    lastSpeed: null, speedRunning: false, logStatus: null,
  };
  const tty = new Tty();
  const tui = !opts.plain && tty.canTui();
  const logger = await openLogger(opts, startedAt, startedWall, ui);
  logNotice(tui, ui.logStatus, opts.log);
  const g = glyphs(opts.ascii);
  let lastSnap: Snapshot | null = null;
  const alerter = new Alerter((s) => {
    if (tui || process.stdout.isTTY) process.stdout.write(s); // never into a piped plain log
  }, opts.bell);
  const redraw = (): void => {
    if (tui && lastSnap) drawTui(tty, lastSnap, ui, g, opts.color);
  };

  let routeKey = '';
  let ticks = 0;
  const probes = new Probes(store, opts, missing, {
    onRoute: (info) => {
      // §11: the meta row waits for this first poll so iface/wifiIface/gateway/vpn are filled in
      logger?.writeMeta({ iface: info.egressIface, wifiIface: info.wifiIface, gateway: info.gateway, vpn: info.vpn });
      const key = `${info.egressIface}|${info.gateway}|${info.vpn}`;
      if (key === routeKey) return;
      routeKey = key;
      logger?.event(routeEvent(info));
    },
    onWifi: (w) => logger?.event(wifiEvent(w)),
    onIfaceIgnored: (iface, egress) => ifaceNotice(tui, ui, iface, egress),
  });

  const onTick = (now: number, gapMs: number): void => {
    if (ticks++ > 0) logger?.writeMeta(); // no route poll by the second tick: write the header anyway
    const wall = wallNow();
    const o = store.tick(now, wall, gapMs, probes.health(now));
    lastSnap = o.snap;
    if (o.gap) {
      probes.onGap();
      logger?.event(gapEvent(o.gap.fromWall, o.gap.toWall), now, wall);
    }
    for (const t of o.transitions) {
      alerter.onTransition(t, now);
      ui.flashTicksLeft = FLASH_TICKS;
      logger?.event(transitionEvent(t), now, wall);
      if (!tui) out.line(renderPlainEvent(t));
    }
    for (const c of o.closed) {
      logger?.event(outageEvent(c), now, wall);
      if (!tui) out.line(renderPlainEvent(c));
    }
    probes.adjust(o.snap, o.transitions);
    logger?.tick(o.snap, store.latestRtts());
    if (logger && logger.status !== ui.logStatus) {
      ui.logStatus = logger.status; // §10 self-disabled mid-run
      logNotice(tui, logger.status, opts.log);
    }
    if (tui) {
      redraw();
      if (ui.flashTicksLeft > 0) ui.flashTicksLeft--;
    } else {
      out.line(renderPlainLine(o.snap));
    }
  };

  const ticker = new Ticker(TICK_MS);
  wireShutdown(ticker, probes, logger, () => {
    if (lastSnap && out.alive()) out.line(quitReport(lastSnap, g));
  });

  if (tui) enterTui(tty, { store, ui, opts, alerter, logger, snap: () => lastSnap, redraw });
  probes.start();
  onTick(monoNow(), 0); // first frame / line at once; the ticker takes over after TICK_MS
  ticker.start(onTick);
}

if (import.meta.main) {
  void main();
}
