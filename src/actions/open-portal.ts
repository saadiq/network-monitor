// §8.4 `o` key: open the portal login page with /usr/bin/open via proc.run.
import { BIN, DEFAULT_PORTAL_URL, DETECTOR_ORDER } from '../config';
import { run } from '../core/proc';
import { captiveUrl } from '../probes/http';
import type { Snapshot } from '../model/types';

export const OPEN_TIMEOUT_MS = 5000;

export type OpenOutcome = { ok: true } | { ok: false; reason: string };

/** Only http(s) URLs may be handed to `open` (a redirect could name a file or app scheme). */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/**
 * A portal that answered 200 without a Location leaves the detector URL behind: that is no
 * redirect. Read through `captiveUrl` (not the static table) so a NETMON_CAPTIVE_URL override
 * is filtered too — otherwise `o` would just reopen the probe URL on a dev run.
 */
function captured(url: string | null | undefined): string | null {
  if (!url) return null;
  return DETECTOR_ORDER.some((d) => captiveUrl(d) === url) ? null : url;
}

/** §8.4 precedence: redirect of the last portal result → --portal-url → captive.apple.com. */
export function portalUrl(snap: Pick<Snapshot, 'signals' | 'http'>, opts: { portalUrl: string | null }): string {
  const fromHttp = snap.http?.kind === 'portal' ? snap.http.redirectUrl : null;
  return captured(snap.signals.portalRedirectUrl) ?? captured(fromHttp) ?? (opts.portalUrl || DEFAULT_PORTAL_URL);
}

/** Run `/usr/bin/open <url>`; never throws. */
export async function openUrl(url: string): Promise<OpenOutcome> {
  if (!isWebUrl(url)) return { ok: false, reason: 'not a web URL' };
  const r = await run([BIN.open, url], OPEN_TIMEOUT_MS);
  if (r.ok) return { ok: true };
  if (r.err === 'ENOENT') return { ok: false, reason: 'open: missing' };
  if (r.timedOut) return { ok: false, reason: 'open: timeout' };
  return { ok: false, reason: `open: exit ${r.code ?? '?'}` };
}

export async function openPortal(url: string): Promise<void> {
  await openUrl(url);
}
