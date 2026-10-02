// End-to-end: the real program under a pseudo-terminal via /usr/bin/expect (stock on macOS) must
// enter the alt screen, keep drawing frames with no key pressed, and quit cleanly on q.
// NOTE: the wait must be `expect { timeout {} }`, never `sleep` — sleep does not read the pty, the
// child's output queue fills, and its tcsetattr()/writes stall until expect reads again.
// Skipped where expect is missing.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPECT = '/usr/bin/expect';
const ROOT = join(import.meta.dir, '..');
const hasExpect = await Bun.file(EXPECT).exists();

test.skipIf(!hasExpect)('TUI draws frames every second under a pty and quits on q', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmon-pty-'));
  const script = join(dir, 'tui.exp');
  writeFileSync(script, [
    'spawn -noecho bun run src/main.ts --no-bell',
    'stty rows 30 columns 100 < $spawn_out(slave,name)',
    'set timeout 4',
    'expect { timeout {} }',
    'send "q"',
    'set timeout 15',
    'expect eof',
    '',
  ].join('\n'));
  const proc = Bun.spawn([EXPECT, script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  const frames = (out.match(/\x1b\[1;1H/g) ?? []).length;
  expect(frames).toBeGreaterThanOrEqual(3); // ≈ 5 frames in 4 s; 1 means the loop was blocked
  expect(out).toContain('\x1b[?1049h'); // alt screen entered
  expect(out).toContain('\x1b[?1049l'); // ...and left on q
  expect(out.slice(out.lastIndexOf('\x1b[?1049l'))).toContain('Probe traffic'); // quit report after leaving
  expect(out).not.toContain('\x1b[?1049h\x1b[?25l\x1b[2Jq'); // the key was never echoed (raw mode was on)
}, 30_000);

test.skipIf(!hasExpect)('v switches to the advanced view and back, live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmon-pty-'));
  const script = join(dir, 'view.exp');
  writeFileSync(script, [
    'spawn -noecho bun run src/main.ts --no-bell',
    'stty rows 30 columns 100 < $spawn_out(slave,name)',
    'set timeout 3',
    'expect { timeout {} }',
    'send "v"',
    'set timeout 3',
    'expect { timeout {} }',
    'send "v"',
    'set timeout 3',
    'expect { timeout {} }',
    'send "q"',
    'set timeout 15',
    'expect eof',
    '',
  ].join('\n'));
  const proc = Bun.spawn([EXPECT, script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  const firstAdvanced = out.indexOf('v simple');
  expect(out.indexOf('v details')).toBeGreaterThanOrEqual(0); // starts in the simple view
  expect(firstAdvanced).toBeGreaterThan(out.indexOf('v details')); // ...then the advanced footer
  expect(out.indexOf('v details', firstAdvanced)).toBeGreaterThan(firstAdvanced); // ...and back
  expect(out).toContain('\x1b[?1049l'); // left the alt screen on q
}, 30_000);
