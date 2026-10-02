# netmon — network health monitor (Bun + TypeScript, macOS)

- Spec: `docs/superpowers/specs/2026-09-06-network-monitor-design.md` (authoritative; section numbers are referenced in code comments).
- Run: `bun run src/main.ts` (or `bun start`). Tests: `bun test`. Typecheck: `bunx tsc --noEmit`.
- Zero runtime dependencies. `@types/bun` is dev-only for typecheck. Never add a runtime dep.
- Hard limits: ≤ 300 lines per file, ≤ 100 lines per function. Prefer small pure modules with unit tests.
- All shell tools are invoked by absolute path via `src/core/proc.ts` (`run` / `streamLines`); nothing needs sudo.
- Pure modules (parsers, model, UI sections) take plain data in and return plain data/strings; side effects live only in `proc`, `clock`, pollers/streams, `tty`, `alerts`, `open-portal`, `jsonl` I/O and `main`.

## Runtime notes worth knowing before editing

- `--target` takes an IPv4 address only (`cli/args.ts`): `route -n get` and `ping` need an address, and a hostname there makes every route poll fail, i.e. NO LINK on a healthy network.
- Plain/piped mode ends when its stdout reader goes away: `main.ts` listens for EPIPE on stdout and runs the normal shutdown, so `netmon --plain | head -3` leaves no ticker, probes or `ping` children behind.
- Outside the TUI there is no footer, so a `--log` that cannot be opened (or that self-disables mid-run) prints one line on stderr: `netmon: log off (ENOENT): <path>`.
- The §11 JSONL meta row is written on the first route poll (or at the second tick if none arrives), so it carries `iface`/`wifiIface`/`gateway`/`vpn`; rows produced before it are held by `JsonlLogger` and land right after it.
- `--iface X` is inert when a live non-VPN route egresses elsewhere. It is announced once — `netmon: --iface X is not the egress (en0)` on stderr outside the TUI, a footer message inside it — rather than silently ignored (`ifaceIgnored()` in `app/probes.ts`).
- `system_profiler` is spawned with `-nospawn` (`probes/wifi.ts`). Without it the tool forks an unkillable `-xml … -detailLevel full` helper that outlives us as a launchd orphan; `WIFI_KILL_MS` cannot reach a grandchild.

## Dev/test env overrides

Dev-only, read per call by the probes (`src/probes/env.ts`); deliberately absent from `--help`. They point a probe at an unreachable endpoint so the DOWN/uplink and portal paths can be exercised live without touching the real network.

| Variable | Overrides | Example |
|---|---|---|
| `NETMON_CAPTIVE_URL` | the URL of both §4.3 captive detectors | `http://10.255.255.1/x` |
| `NETMON_HTTPS_URL` | §4.4 HTTPS cross-check URL | `https://10.255.255.1/x` |
| `NETMON_DNS_SERVER` | §4.5 direct resolver (default `@1.1.1.1`) | `10.255.255.1` |

```
NETMON_CAPTIVE_URL=http://10.255.255.1/x NETMON_HTTPS_URL=https://10.255.255.1/x \
  bun run src/main.ts --plain --target 10.255.255.1
```

## Driving the real UI

- Plain mode: `bun run src/main.ts --plain` (one line per second); stop it with `kill -INT <pid>` so the shutdown path runs.
- Mock frames: `bun run scripts/render-once.ts [--view simple|advanced|both]` renders the mock Snapshot in each view (simple at 40×10 … 160×50, advanced at 100×30 and 80×24) with escapes stripped. The TUI starts in the simple view; `v` toggles.
- Real TUI under a pty: `expect scripts/tui-session.exp > out.txt`, then `bun run scripts/pty-frame.ts out.txt` for the last frame.
- In expect scripts, wait with `set timeout N; expect { timeout {} }` — NEVER `sleep`: sleep does not drain the pty, the child's output queue fills and its `tcsetattr()`/writes stall, which looks exactly like a hung event loop but is a harness artifact.
- Never press `o` in a live TUI (it opens a browser on the user's machine); test `openPortal` only with an injected run function. Never change network settings (no `networksetup` writes, no Wi-Fi off, no sudo).
