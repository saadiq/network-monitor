import { test, expect } from 'bun:test';
import { parsePingLine } from '../src/probes/ping-parse';

// Fixtures captured on this machine: `/sbin/ping -n -c 2 -s 16 <host>` (§4.2).
const okFixture = await Bun.file(new URL('./fixtures/ping-1.1.1.1.txt', import.meta.url)).text();
const filteredFixture = await Bun.file(new URL('./fixtures/ping-10.255.255.1.txt', import.meta.url)).text();

test('reply line with -s 16 (24 bytes from) parses seq, rtt, dup=false', () => {
  expect(parsePingLine('24 bytes from 1.1.1.1: icmp_seq=0 ttl=54 time=104.677 ms')).toEqual({
    kind: 'reply', seq: 0, rttMs: 104.677, dup: false,
  });
  expect(parsePingLine('24 bytes from 192.168.0.1: icmp_seq=17 ttl=64 time=7.02 ms')).toEqual({
    kind: 'reply', seq: 17, rttMs: 7.02, dup: false,
  });
  // trailing whitespace / CR tolerated
  expect(parsePingLine('24 bytes from 1.1.1.1: icmp_seq=1 ttl=54 time=16.437 ms \r')).toEqual({
    kind: 'reply', seq: 1, rttMs: 16.437, dup: false,
  });
});

test('DUP! reply is flagged dup', () => {
  expect(parsePingLine('24 bytes from 1.1.1.1: icmp_seq=3 ttl=54 time=12.3 ms (DUP!)')).toEqual({
    kind: 'reply', seq: 3, rttMs: 12.3, dup: true,
  });
});

test('Request timeout line', () => {
  expect(parsePingLine('Request timeout for icmp_seq 0')).toEqual({ kind: 'timeout', seq: 0 });
  expect(parsePingLine('Request timeout for icmp_seq 1234')).toEqual({ kind: 'timeout', seq: 1234 });
});

test('sendto stderr lines are LOCAL_ERROR events with the reason', () => {
  expect(parsePingLine('ping: sendto: No route to host')).toEqual({ kind: 'error', reason: 'No route to host' });
  expect(parsePingLine('ping: sendto: Network is unreachable')).toEqual({ kind: 'error', reason: 'Network is unreachable' });
  expect(parsePingLine('ping: sendto: Host is down')).toEqual({ kind: 'error', reason: 'Host is down' });
});

test('header, statistics, summary and blank lines are ignored', () => {
  for (const line of [
    'PING 1.1.1.1 (1.1.1.1): 16 data bytes',
    '--- 1.1.1.1 ping statistics ---',
    '2 packets transmitted, 2 packets received, 0.0% packet loss',
    '2 packets transmitted, 0 packets received, 100.0% packet loss',
    'round-trip min/avg/max/stddev = 16.437/60.557/104.677/44.120 ms',
    '',
    '   ',
  ]) {
    expect(parsePingLine(line)).toEqual({ kind: 'ignore' });
  }
});

test('ICMP error notices and their IP header dump are ignored (not loss, not errs)', () => {
  for (const line of [
    '76 bytes from 67.87.20.1: Communication prohibited by filter',
    '92 bytes from 192.168.0.1: Destination Host Unreachable',
    '36 bytes from 10.0.0.1: Time to live exceeded',
    'Vr HL TOS  Len   ID Flg  off TTL Pro  cks      Src      Dst',
    ' 4  5  00 2c00 735d   0 0000  3e  01 3e8a 192.168.0.65  10.255.255.1 ',
  ]) {
    expect(parsePingLine(line)).toEqual({ kind: 'ignore' });
  }
});

test('anything else is unknown and keeps the line', () => {
  expect(parsePingLine('ping: cannot resolve nope.invalid: Unknown host')).toEqual({
    kind: 'unknown', line: 'ping: cannot resolve nope.invalid: Unknown host',
  });
  expect(parsePingLine('wrong data byte #8 should be 0x8 but was 0x0')).toEqual({
    kind: 'unknown', line: 'wrong data byte #8 should be 0x8 but was 0x0',
  });
  // a reply-looking line with a malformed field is not a reply
  expect(parsePingLine('24 bytes from 1.1.1.1: icmp_seq=x ttl=54 time=1 ms').kind).toBe('unknown');
});

test('captured 1.1.1.1 fixture: 2 replies, everything else ignored', () => {
  const events = okFixture.split('\n').map(parsePingLine);
  const kinds = events.map((e) => e.kind);
  expect(kinds.filter((k) => k === 'reply').length).toBe(2);
  expect(kinds.filter((k) => k === 'unknown').length).toBe(0);
  expect(kinds.filter((k) => k === 'timeout').length).toBe(0);
  expect(events[1]).toEqual({ kind: 'reply', seq: 0, rttMs: 104.677, dup: false });
  expect(events[2]).toEqual({ kind: 'reply', seq: 1, rttMs: 16.437, dup: false });
});

test('captured 10.255.255.1 fixture: 1 timeout, filter notices ignored, no unknown', () => {
  const events = filteredFixture.split('\n').map(parsePingLine);
  const kinds = events.map((e) => e.kind);
  expect(kinds.filter((k) => k === 'timeout').length).toBe(1);
  expect(kinds.filter((k) => k === 'reply').length).toBe(0);
  expect(kinds.filter((k) => k === 'error').length).toBe(0);
  expect(kinds.filter((k) => k === 'unknown').length).toBe(0);
  expect(events[5]).toEqual({ kind: 'timeout', seq: 0 });
});
