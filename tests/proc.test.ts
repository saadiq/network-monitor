import { test, expect } from 'bun:test';
import { run, streamLines, killAll, preflight, childCount } from '../src/core/proc';

const SCRATCH = process.env['TMPDIR'] ?? '/tmp';
const SH = '/bin/sh';

/** A fifo nobody writes to: `cat <fifo>` blocks in open() until killed. */
async function makeFifo(name: string): Promise<string> {
  const path = `${SCRATCH.replace(/\/$/, '')}/netmon-proc-${name}-${process.pid}.fifo`;
  await run(['/bin/rm', '-f', path], 2000);
  const r = await run(['/usr/bin/mkfifo', path], 2000);
  expect(r.ok).toBe(true);
  return path;
}

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---- run() -------------------------------------------------------------------

test('run: /bin/echo succeeds with stdout captured', async () => {
  const r = await run(['/bin/echo', 'hello'], 2000);
  expect(r.ok).toBe(true);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('hello\n');
  expect(r.stderr).toBe('');
  expect(r.timedOut).toBe(false);
  expect(r.err).toBeUndefined();
  expect(r.ms).toBeGreaterThanOrEqual(0);
  expect(r.ms).toBeLessThan(2000);
});

test('run: non-zero exit and stderr are reported, ok=false', async () => {
  const r = await run([SH, '-c', 'echo out; echo err >&2; exit 3'], 2000);
  expect(r.ok).toBe(false);
  expect(r.code).toBe(3);
  expect(r.stdout).toBe('out\n');
  expect(r.stderr).toBe('err\n');
  expect(r.timedOut).toBe(false);
});

test('run: missing binary → err ENOENT, never throws', async () => {
  const r = await run(['/nonexistent/netmon-bin', '--x'], 1000);
  expect(r.ok).toBe(false);
  expect(r.err).toBe('ENOENT');
  expect(r.code).toBeNull();
  expect(r.stdout).toBe('');
  expect(r.timedOut).toBe(false);
});

test('run: empty argv → err SPAWN, never throws', async () => {
  const r = await run([], 1000);
  expect(r.ok).toBe(false);
  expect(r.err).toBe('SPAWN');
});

test('run: /bin/cat blocked on a fifo is SIGTERMed at timeout', async () => {
  const fifo = await makeFifo('cat');
  const t0 = performance.now();
  const r = await run(['/bin/cat', fifo], 200);
  const took = performance.now() - t0;
  expect(r.timedOut).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.code).toBeNull(); // killed by signal
  expect(took).toBeGreaterThanOrEqual(190);
  expect(took).toBeLessThan(1500);
  await run(['/bin/rm', '-f', fifo], 2000);
});

test('run: child ignoring SIGTERM is SIGKILLed 500 ms later', async () => {
  const t0 = performance.now();
  const r = await run([SH, '-c', 'trap "" TERM; sleep 10'], 200);
  const took = performance.now() - t0;
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
  expect(took).toBeGreaterThanOrEqual(650);
  expect(took).toBeLessThan(3000);
});

test('run: returns after exit even when a grandchild keeps the pipe open', async () => {
  const t0 = performance.now();
  const r = await run([SH, '-c', 'echo hi; sleep 5 & exit 0'], 3000);
  const took = performance.now() - t0;
  expect(r.ok).toBe(true);
  expect(r.stdout).toBe('hi\n');
  expect(took).toBeLessThan(2500);
});

test('run: large output is drained without deadlock', async () => {
  const r = await run([SH, '-c', 'i=0; while [ $i -lt 4000 ]; do echo "0123456789abcdef0123456789abcdef"; i=$((i+1)); done'], 5000);
  expect(r.ok).toBe(true);
  expect(r.stdout.length).toBe(4000 * 33);
});

// ---- streamLines() -----------------------------------------------------------

type Got = { line: string; src: 'stdout' | 'stderr' };

function collect(argv: string[]): Promise<{ lines: Got[]; code: number | null; pid: number }> {
  return new Promise((resolve) => {
    const lines: Got[] = [];
    const h = streamLines(argv, {
      onLine: (line, src) => lines.push({ line, src }),
      onExit: (code) => resolve({ lines, code, pid: h.pid }),
    });
  });
}

test('streamLines: stdout and stderr lines, partial trailing line flushed at EOF', async () => {
  const script = 'printf "a\\nb\\n"; printf "e1\\n" >&2; printf "partial"';
  const { lines, code, pid } = await collect([SH, '-c', script]);
  expect(code).toBe(0);
  expect(pid).toBeGreaterThan(0);
  expect(lines.filter((l) => l.src === 'stdout').map((l) => l.line)).toEqual(['a', 'b', 'partial']);
  expect(lines.filter((l) => l.src === 'stderr').map((l) => l.line)).toEqual(['e1']);
});

test('streamLines: a line split across chunks is buffered until its newline', async () => {
  const script = 'printf "hel"; sleep 0.1; printf "lo\\nwor"; sleep 0.1; printf "ld\\n"';
  const { lines } = await collect([SH, '-c', script]);
  expect(lines.map((l) => l.line)).toEqual(['hello', 'world']);
});

test('streamLines: multibyte UTF-8 split across chunks decodes correctly; CR stripped', async () => {
  const script = 'printf "caf\\303"; sleep 0.1; printf "\\251\\r\\n\\n"';
  const { lines } = await collect([SH, '-c', script]);
  expect(lines.map((l) => l.line)).toEqual(['café', '']);
});

test('streamLines: onExit carries the exit code and fires after every line', async () => {
  const { lines, code } = await collect([SH, '-c', 'echo x; echo y; exit 4']);
  expect(lines.map((l) => l.line)).toEqual(['x', 'y']);
  expect(code).toBe(4);
});

test('streamLines: missing binary → onExit(null) asynchronously, handle is inert', async () => {
  const exited: (number | null)[] = [];
  const h = streamLines(['/nonexistent/netmon-stream'], {
    onLine: () => {},
    onExit: (code) => exited.push(code),
  });
  expect(exited).toEqual([]); // not delivered synchronously
  expect(h.pid).toBe(-1);
  expect(() => h.kill()).not.toThrow();
  await wait(20);
  expect(exited).toEqual([null]);
});

test('streamLines: kill() terminates a running child, onExit(null) follows', async () => {
  const fifo = await makeFifo('stream');
  const t0 = performance.now();
  let code: number | null | undefined;
  const done = new Promise<void>((res) => {
    const h = streamLines(['/bin/cat', fifo], {
      onLine: () => {},
      onExit: (c) => { code = c; res(); },
    });
    expect(h.startedAt).toBeGreaterThan(0);
    setTimeout(() => { h.kill(); h.kill(); }, 50); // idempotent
  });
  await done;
  expect(code).toBeNull();
  expect(performance.now() - t0).toBeLessThan(1500);
  await run(['/bin/rm', '-f', fifo], 2000);
});

// ---- registry / killAll ------------------------------------------------------

test('killAll: SIGTERMs every registered child; registry drains on exit', async () => {
  const codes: (number | null)[] = [];
  const both = Promise.all([1, 2].map(() => new Promise<void>((res) => {
    streamLines(['/bin/sleep', '10'], { onLine: () => {}, onExit: (c) => { codes.push(c); res(); } });
  })));
  await wait(30);
  expect(childCount()).toBeGreaterThanOrEqual(2);
  killAll();
  await both;
  expect(codes).toEqual([null, null]);
  await wait(20);
  expect(childCount()).toBe(0);
});

// ---- preflight ---------------------------------------------------------------

test('preflight: returns only the missing paths', async () => {
  const missing = await preflight(['/bin/echo', '/nonexistent/netmon-a', '/bin/sh', '/nonexistent/netmon-b']);
  expect([...missing].sort()).toEqual(['/nonexistent/netmon-a', '/nonexistent/netmon-b']);
});

test('preflight: empty list → empty set', async () => {
  expect((await preflight([])).size).toBe(0);
});
