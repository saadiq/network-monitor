// §8.4 key actions: t (speed test), b (bell), o (open portal). Side effects: proc.run through
// speed.ts / open-portal.ts, footer messages, log events.
import type { Options } from '../cli/types';
import { monoNow, wallNow } from '../core/clock';
import { fmtMbps } from '../core/format';
import { speedEvent } from '../log/events';
import type { JsonlLogger } from '../log/jsonl';
import type { Alerter } from '../actions/alerts';
import { openUrl, portalUrl } from '../actions/open-portal';
import type { Store } from '../model/store';
import type { Snapshot, UiState } from '../model/types';
import { canRun, runSpeedTest } from '../probes/speed';

/** How long a transient footer message stays visible. */
export const FOOTER_MSG_MS = 5000;

export interface ActionCtx {
  store: Store;
  ui: UiState;
  opts: Options;
  alerter: Alerter;
  logger: JsonlLogger | null;
  snap(): Snapshot | null;
  redraw(): void;
}

export function showFooter(ctx: ActionCtx, msg: string): void {
  ctx.ui.footerMsg = msg;
  ctx.ui.footerMsgUntil = monoNow() + FOOTER_MSG_MS;
  ctx.redraw();
}

/** `t`: §4.9 refusal rules, then the 250 KB download with loaded tagging around it (§4.8). */
export async function speedAction(ctx: ActionCtx): Promise<void> {
  const snap = ctx.snap();
  if (!snap || ctx.ui.speedRunning) return;
  const now = monoNow();
  const c = canRun(now, ctx.ui.lastSpeed, snap.state);
  if (!c.ok) {
    showFooter(ctx, c.why ?? 'speed test refused');
    return;
  }
  ctx.ui.lastSpeed = now;
  ctx.ui.speedRunning = true;
  ctx.store.onSpeedStart(now);
  ctx.redraw();
  const r = await runSpeedTest();
  const at = monoNow();
  ctx.ui.speedRunning = false;
  ctx.store.onSpeed(r, at);
  ctx.logger?.event(speedEvent(r), at, wallNow());
  const msg = r.ok && r.downMbps != null ? `speed test: ${fmtMbps(r.downMbps)} down` : `speed test failed (${r.why ?? '?'})`;
  showFooter(ctx, msg);
}

/** `o`: open the portal URL (§8.4 precedence) with /usr/bin/open. */
export async function portalAction(ctx: ActionCtx): Promise<void> {
  const snap = ctx.snap();
  if (!snap) return;
  const url = portalUrl(snap, ctx.opts);
  showFooter(ctx, `opening ${url}`);
  const r = await openUrl(url);
  if (!r.ok) showFooter(ctx, r.reason);
}

/** `b`: toggle the bell; the footer shows the new state. */
export function bellAction(ctx: ActionCtx): void {
  ctx.ui.bellOn = ctx.alerter.toggle();
  ctx.redraw();
}
