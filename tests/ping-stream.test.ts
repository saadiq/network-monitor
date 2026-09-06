import { test, expect } from 'bun:test';
import { PingStream, pingArgv } from '../src/probes/ping-stream';
import type { LineSink, Spawner, StreamHandle } from '../src/probes/ping-stream';
import type { PingEvent } from '../src/probes/types';

interface Proc { argv: string[]; sink: LineSink; killed: boolean; pid: number }

/** Fake §9 streamLines: records spawns, lets the test push lines / exits. */
function fakeSpawner(): { spawn: Spawner; procs: Proc[] } {
  const procs: Proc[] = [];
  const spawn: Spawner = (argv, sink) => {
    const p: Proc = { argv, sink, killed: false, pid: 1000 + procs.length };
    procs.push(p);
    const h: StreamHandle = { kill: () => { p.killed = true; }, pid: p.pid, startedAt: 0 };
    return h;
  };
  return { spawn, procs };
}

type Ev = { e: PingEvent; at: number; gen: number };

function setup(): { s: PingStream; procs: Proc[]; events: Ev[]; clock: { t: number } } {
  const clock = { t: 10_000 };
  const { spawn, procs } = fakeSpawner();
  const s = new PingStream(spawn, () => clock.t);
  const events: Ev[] = [];
  s.onEvent((e, at, gen) => events.push({ e, at, gen }));
  return { s, procs, events, clock };
}

test('pingArgv is the §4.2 command with absolute path', () => {
  expect(pingArgv('1.1.1.1')).toEqual(['/sbin/ping', '-n', '-i', '1', '-s', '16', '1.1.1.1']);
});

test('start spawns once, emits a spawn marker, and tags parsed lines with arrival time and generation', () => {
  const { s, procs, events, clock } = setup();
  s.start('1.1.1.1');
  expect(procs.length).toBe(1);
  expect(procs[0]?.argv).toEqual(pingArgv('1.1.1.1'));
  expect(s.generation).toBe(1);
  expect(events).toEqual([{ e: { kind: 'ignore' }, at: 10_000, gen: 1 }]);
  clock.t = 10_050;
  procs[0]?.sink.onLine('24 bytes from 1.1.1.1: icmp_seq=0 ttl=54 time=30.1 ms', 'stdout');
  clock.t = 11_020;
  procs[0]?.sink.onLine('ping: sendto: No route to host', 'stderr');
  expect(events[1]).toEqual({ e: { kind: 'reply', seq: 0, rttMs: 30.1, dup: false }, at: 10_050, gen: 1 });
  expect(events[2]).toEqual({ e: { kind: 'error', reason: 'No route to host' }, at: 11_020, gen: 1 });
  expect(s.stalled(11_020)).toBe(false);
  expect(s.stalled(14_020)).toBe(true); // 3 s without a line
  s.stop();
  expect(procs[0]?.killed).toBe(true);
  expect(s.stalled(14_021)).toBe(true);
});

test('retarget kills the old process, bumps the generation, and drops the old process lines', () => {
  const { s, procs, events, clock } = setup();
  s.start('192.168.0.1');
  clock.t = 12_000;
  s.retarget('10.0.0.1');
  expect(procs[0]?.killed).toBe(true);
  expect(procs.length).toBe(2);
  expect(procs[1]?.argv.at(-1)).toBe('10.0.0.1');
  expect(s.generation).toBe(2);
  expect(s.target).toBe('10.0.0.1');
  const before = events.length;
  procs[0]?.sink.onLine('24 bytes from 192.168.0.1: icmp_seq=7 ttl=64 time=7 ms', 'stdout');
  procs[0]?.sink.onExit(null);
  expect(events.length).toBe(before); // stale process ignored
  expect(procs.length).toBe(2); // and its exit does not trigger a restart
  procs[1]?.sink.onLine('24 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=5 ms', 'stdout');
  expect(events.at(-1)?.gen).toBe(2);
  s.stop();
});

test('process exit → restart after the 1 s backoff with a new generation; stop cancels pending restarts', async () => {
  const { s, procs, clock } = setup();
  s.start('1.1.1.1');
  clock.t = 15_000;
  procs[0]?.sink.onExit(1);
  expect(procs.length).toBe(1);
  expect(s.stalled(15_000)).toBe(true); // no live process
  await Bun.sleep(1_150);
  expect(procs.length).toBe(2);
  expect(s.generation).toBe(2);
  clock.t = 16_200;
  procs[1]?.sink.onExit(1);
  s.stop();
  await Bun.sleep(1_150);
  expect(procs.length).toBe(2); // stopped: no relaunch
});

test('watchdog: 5 s without a line kills the process and schedules a restart', async () => {
  const { s, procs, clock } = setup();
  s.start('1.1.1.1');
  clock.t = 14_999;
  s.check(clock.t);
  expect(procs[0]?.killed).toBe(false);
  clock.t = 15_000;
  s.check(clock.t);
  expect(procs[0]?.killed).toBe(true);
  s.check(clock.t + 100); // idempotent while a restart is pending
  await Bun.sleep(1_150);
  expect(procs.length).toBe(2);
  expect(s.generation).toBe(2);
  s.stop();
});
