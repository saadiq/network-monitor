// Dev-only endpoint overrides. Deliberately absent from --help (they are documented in
// CLAUDE.md): they exist so the offline paths (DOWN(uplink), DEGRADED(dns), captive) can be
// exercised against unreachable endpoints on a live machine — e.g.
// `NETMON_CAPTIVE_URL=http://10.255.255.1/x bun run src/main.ts --target 10.255.255.1` —
// without changing a single network setting. Read per call, so a value is picked up per run.

/** The http(s) URL in `name`, or `fallback`. Anything that is not an http(s) URL is ignored. */
export function envUrl(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v !== undefined && /^https?:\/\/\S+$/i.test(v) ? v : fallback;
}

/** The resolver address in `name` (host / dotted quad / v6), or `fallback`. */
export function envServer(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v !== undefined && /^[A-Za-z0-9._:-]+$/.test(v) ? v : fallback;
}
