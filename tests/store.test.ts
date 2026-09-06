// Store integration: scripted ping/http/dns feeds through Store.tick() → WARMUP → UP → DOWN(uplink)
// (backdated) → UP (outage closed) → sleep gap → WARMUP. No I/O; clocks are injected.
// The Sim harness itself lives in tests/helpers/store-sim.ts.
import { describe, expect, test } from 'bun:test';
import {
  BASE, dnsOk, EPOCH, healthy, healthyTick, httpFail, httpOk, Sim, upDropUp, WALL,
} from './helpers/store-sim';

describe('Store', () => {
  test('WARMUP → UP, then a clean drop → DOWN(uplink) backdated, recovery → UP with one closed outage', () => {
    const sim = new Sim();
    const s = sim.store;
    healthy(sim, 1);
    s.onHttp(httpOk(BASE + 500));
    s.onDns(dnsOk(BASE + 500));
    let out = sim.tick();
    expect(out.snap.state).toBe('WARMUP');
    expect(out.snap.verdicts.map((v) => v.level)).toEqual(['?', '?', '?', '?']);
    expect(out.snap.banner[1]).toContain('Measuring');

    for (let i = 2; i <= 9; i++) {
      healthy(sim, i);
      if (i === 5) s.onHttp(httpOk(BASE + 5000));
      out = sim.tick();
    }
    expect(sim.log).toEqual(['2:WARMUP>UP/-']); // captive ok before tick 1 → inetOk (§6.2), UP confirmed after 2 ticks
    expect(out.snap.state).toBe('UP');
    expect(out.snap.gw.p50).toBe(6);
    expect(out.snap.latencyMs).toBe(45);
    expect(out.snap.latencySource).toBe('icmp');
    expect(out.snap.signals.inetLink).toBe('up');
    expect(out.snap.dnsOk).toBe(true);
    expect(out.snap.dnsServer).toBe('100.100.100.100');
    expect(out.snap.grade.grade).toBe('A'); // 5-tick hold satisfied by tick 9
    expect(out.snap.verdicts.map((v) => v.name)).toEqual(['CHAT', 'BROWSE', 'VIDEO CALL', 'DOWNLOAD']);
    expect(out.snap.timeline(90, 10000)).toHaveLength(90);
    expect(out.snap.rttHistory.length).toBeGreaterThanOrEqual(8);
    expect(out.snap.probeBytes).toBeGreaterThan(0);

    // seqs 9.. lost on the internet stream; the gateway keeps answering (§6.3 DOWN/uplink)
    for (let i = 10; i <= 18; i++) {
      sim.reply('gw', i - 1, 6);
      if (i - 2 >= 9) sim.timeout('inet', i - 2); // ping prints the timeout at the next send
      if (i === 14) s.onHttp(httpFail(BASE + 13_000)); // the out-of-band check launched at the flip
      out = sim.tick();
    }
    expect(sim.log).toEqual(['2:WARMUP>UP/-', '15:UP>DOWN/uplink']);
    const down = out.transitions.length ? out : null;
    expect(down).toBeNull(); // no transition on tick 18 itself
    expect(out.snap.state).toBe('DOWN');
    expect(out.snap.cause).toBe('uplink');
    expect(out.snap.openOutage?.startedAt).toBe(WALL + (EPOCH + 9000 - BASE)); // backdated to the first LOST
    expect(out.snap.downFor).toBe(Math.round((BASE + 18_000 - (EPOCH + 9000)) / 1000));
    expect(out.snap.verdicts.map((v) => v.level)).toEqual(['NO', 'NO', 'NO', 'NO']);
    expect(out.snap.banner[1]).toContain("Upstream link dropped");
    expect(out.snap.grade.grade).toBeNull();

    // replies resume from seq 18
    for (let i = 19; i <= 22; i++) {
      healthy(sim, i);
      out = sim.tick();
    }
    expect(sim.log).toEqual(['2:WARMUP>UP/-', '15:UP>DOWN/uplink', '21:DOWN>UP/-']);
    expect(out.snap.state).toBe('UP');
    expect(out.snap.openOutage).toBeNull();
    expect(out.snap.outages).toHaveLength(1);
    const o = out.snap.outages[0];
    expect(o?.cause).toBe('uplink');
    expect(o?.sleep).toBe(false);
    expect(o?.durationS).toBe(9); // first LOST (seq 9) → first RECEIVED of the recovery (seq 18)
    expect(out.snap.drops.dropsSession).toBe(1);
    expect(out.snap.drops.drops15).toBe(1);
    expect(out.snap.steadyFor).toBeCloseTo((BASE + 22_000 - (EPOCH + 18_000)) / 1000, 0);
    // the outage's own 9 lost samples are still in loss60, but the verdicts read the steady run
    expect(out.snap.loss60).toBeCloseTo((9 / 22) * 100, 0);
    expect(out.snap.verdicts.find((v) => v.name === 'CHAT')?.reason).toBe('just came back');
  });

  test('a tick gap ≥ 5 s closes the open outage as sleep and passes through WARMUP', () => {
    const sim = new Sim();
    const s = sim.store;
    healthy(sim, 1);
    s.onHttp(httpOk(BASE + 500));
    s.onDns(dnsOk(BASE + 500));
    sim.tick();
    for (let i = 2; i <= 6; i++) {
      healthy(sim, i);
      sim.tick();
    }
    for (let i = 7; i <= 12; i++) {
      sim.reply('gw', i - 1, 6);
      if (i - 2 >= 6) sim.timeout('inet', i - 2);
      if (i === 11) s.onHttp(httpFail(BASE + 10_000));
      sim.tick();
    }
    expect(s.status.state).toBe('DOWN');
    expect(s.tracker.open).not.toBeNull();
    const out = sim.tick(60_000); // laptop slept
    expect(out.gap).not.toBeNull();
    expect(out.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['DOWN>WARMUP']);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]?.sleep).toBe(true);
    expect(out.snap.state).toBe('WARMUP');
    expect(out.snap.drops.dropsSession).toBe(0); // sleep-closed outages are not drops
    expect(out.snap.outages[0]?.sleep).toBe(true);
    expect(out.snap.signals.hasHttpResult).toBe(false); // captive evidence forgotten
  });

  test('no DNS round yet is not "DNS failing"; a failed round is', () => {
    const sim = new Sim();
    const s = sim.store;
    healthy(sim, 1);
    s.onHttp(httpOk(BASE + 500));
    sim.tick();
    for (let i = 2; i <= 4; i++) {
      healthy(sim, i);
      sim.tick();
    }
    expect(s.status.state).toBe('UP');
    const bad = dnsOk(BASE + 4500);
    s.onDns({ ...bad, sys: { ...bad.sys, ok: false, err: 'TIMEOUT' }, direct: { ...bad.direct, ok: false, err: 'TIMEOUT' } });
    healthy(sim, 5);
    const out = sim.tick();
    expect(out.snap.state).toBe('DEGRADED');
    expect(out.snap.cause).toBe('dns');
    expect(out.snap.verdicts.find((v) => v.name === 'BROWSE')?.reason).toBe('DNS failing');
  });

  test('icmpBlocked switches the effective latency/loss source to HTTP + router', () => {
    const sim = new Sim();
    const s = sim.store;
    healthy(sim, 1);
    s.onDns(dnsOk(BASE + 500));
    sim.tick();
    for (let i = 2; i <= 5; i++) {
      healthy(sim, i);
      sim.tick();
    }
    // internet ICMP filtered from seq 5 on, captive checks keep succeeding
    for (let i = 6; i <= 45; i++) {
      sim.reply('gw', i - 1, 6);
      if (i - 2 >= 5) sim.timeout('inet', i - 2);
      if (i % 5 === 0) s.onHttp(httpOk(BASE + i * 1000 - 500));
      sim.tick();
    }
    const snap = s.lastSnap;
    expect(snap?.icmpBlocked).toBe(true);
    expect(snap?.latencySource).toBe('http');
    expect(snap?.latencyMs).toBe(40); // http.connectMs
    expect(snap?.lossSource).toBe('router');
    expect(snap?.loss60).toBe(0); // gateway stream is clean
    expect(snap?.state).toBe('UP');
    expect(snap?.tip).toContain('network blocks ping');
  });

  test('a sleep gap forgets pre-sleep evidence: no phantom drop, WARMUP until fresh samples', () => {
    const sim = new Sim();
    const s = sim.store;
    healthy(sim, 1);
    s.onHttp(httpOk(BASE + 500));
    s.onDns(dnsOk(BASE + 500));
    sim.tick();
    for (let i = 2; i <= 10; i++) healthyTick(sim, i);
    expect(s.status.state).toBe('UP');

    // 3 min asleep; the monotonic clock kept running and a stale ping line could arrive
    const out = sim.tick(180_000, 180_000);
    expect(out.transitions.map((t) => `${t.from}>${t.to}/${t.cause ?? '-'}`)).toEqual(['UP>WARMUP/-']);
    expect(out.snap.state).toBe('WARMUP');
    expect(out.snap.signals.inetLink).toBe('unknown'); // the fold restarts after the gap
    expect(out.snap.signals.hasHttpResult).toBe(false);
    expect(out.snap.dnsOk).toBe(true); // no DNS round since the wake is not "DNS failing"
    expect(out.snap.webFailStreak).toBe(0);
    expect(out.snap.inet.lost).toBe(0); // the sleep is never charged as loss
    expect(out.snap.openOutage).toBeNull();

    // the next second still has no fresh evidence: no candidate may be confirmed off stale data
    const next = sim.tick();
    expect(next.transitions).toEqual([]);
    expect(next.snap.state).toBe('WARMUP');
    expect(next.snap.drops.dropsSession).toBe(0);
  });

  test('a sleep with a paused monotonic clock: the gap spans wall time and drops age past it', () => {
    const sim = new Sim();
    upDropUp(sim);
    expect(sim.store.status.state).toBe('UP');
    expect(sim.store.lastSnap?.drops.dropsSession).toBe(1);
    const beforeWall = WALL + sim.wallMs;

    const out = sim.tick(7_200_000, 1000, 7_200_000); // 2 h asleep, mono paused
    expect(out.gap).toEqual({ fromWall: beforeWall, toWall: beforeWall + 7_200_000 });
    expect(out.snap.state).toBe('WARMUP');
    expect(out.snap.drops.sinceLastDrop).toBeGreaterThanOrEqual(7200); // not "drop 6s ago"
    expect(out.snap.drops.drops15).toBe(0);
    expect(out.snap.drops.uptime15).toBeNull(); // nothing measured in the last 15 min
  });

  test('one lost packet at startup never means DEGRADED(quality) on an otherwise clean link', () => {
    const sim = new Sim();
    const s = sim.store;
    s.onHttp(httpOk(BASE + 500));
    s.onDns(dnsOk(BASE + 500));
    sim.timeout('inet', 0); // the first packet is lost to ARP
    sim.reply('gw', 0, 6);
    sim.tick();
    for (let i = 2; i <= 30; i++) healthyTick(sim, i);
    expect(sim.log).toEqual(['2:WARMUP>UP/-']); // no DEGRADED(quality) from 1 lost of 3–12 samples
    expect(sim.store.lastSnap?.grade.grade).toBe('B');
    expect(sim.store.lastSnap?.loss60).toBeGreaterThan(0); // the metric still shows it
  });

  test('after a drop the grade uses loss since the recovery, not the outage own losses', () => {
    const sim = new Sim();
    upDropUp(sim);
    for (let i = 25; i <= 55; i++) healthyTick(sim, i);
    const snap = sim.store.lastSnap;
    expect(snap?.loss60).toBeGreaterThan(10); // the raw metric still shows the drop
    expect(snap?.lossGrade).toBe(0); // the grade/verdict input sees the clean run
    expect(snap?.state).toBe('UP');
    expect(snap?.grade.grade).toBe('B'); // capped by the recent drop, never dragged to C/D by loss
    expect(snap?.banner[1]).not.toContain('Struggling');
    expect(snap?.verdicts.find((v) => v.name === 'BROWSE')?.level).toBe('OK');
  });
});
