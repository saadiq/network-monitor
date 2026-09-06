// End-to-end CLI behaviour of the real program (§12, §10): argument validation exits before any probe
// starts, a dead stdout reader ends the run, and a log that cannot be opened says so outside the TUI.
// These spawn the actual program, so each probes the live network for about a second.
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GUARD_S = 10; // a hung run is killed by the shell watchdog, never left behind

interface Ran { code: number | null; out: string; err: string; ms: number }

/**
 * Run one shell line from the repo root. A watchdog inside the shell TERMs (then KILLs) every child
 * of that shell after GUARD_S, so a regression cannot leave a monitor and its pings running.
 */
async function sh(line: string): Promise<Ran> {
  const script = [
    `( trap '' TERM; sleep ${GUARD_S}; pkill -TERM -P $$; sleep 2; pkill -KILL -P $$ ) >/dev/null 2>&1 &`,
    'w=$!',
    line,
    'rc=$?',
    'kill -KILL $w >/dev/null 2>&1',
    'exit $rc',
  ].join('\n');
  const t0 = Date.now();
  const proc = Bun.spawn(['/bin/bash', '-c', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: await out, err: await err, ms: Date.now() - t0 };
}

test('--target rejects a hostname before anything is probed (exit 2 + usage)', async () => {
  const r = await sh('bun run src/main.ts --target nonexistent.invalid');
  expect(r.code).toBe(2);
  expect(r.err).toContain('--target must be an IPv4 address');
  expect(r.err).toContain('Usage: bun run src/main.ts');
  expect(r.out).toBe('');
}, 30_000);

test('plain mode stops when the stdout reader goes away (netmon --plain | head -3)', async () => {
  // head exits after 3 lines; without EPIPE handling the ticker and both ping streams run forever.
  const r = await sh('bun run src/main.ts --plain --no-bell | head -3');
  expect(r.out.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
  expect(r.ms).toBeLessThan(GUARD_S * 1000);
}, 30_000);

test('a --log path that cannot be opened is reported on stderr outside the TUI', async () => {
  const r = await sh('bun run src/main.ts --plain --no-bell --log /nonexistent-dir-netmon/x.jsonl | head -2');
  expect(r.err).toContain('log off (ENOENT)');
  expect(r.err).toContain('/nonexistent-dir-netmon/x.jsonl');
  expect(r.ms).toBeLessThan(GUARD_S * 1000);
}, 30_000);
