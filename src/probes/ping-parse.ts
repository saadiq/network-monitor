// §4.2 ping line parser. Pure: one line in, one PingEvent out.
import type { PingEvent } from './types';

// `-s 16` makes replies `24 bytes from …` (fixtures: tests/fixtures/ping-*.txt)
const REPLY = /^(\d+) bytes from ([\d.]+): icmp_seq=(\d+) ttl=(\d+) time=([\d.]+) ms( \(DUP!\))?$/;
const TIMEOUT = /^Request timeout for icmp_seq (\d+)$/;
const SENDTO = /^ping: sendto: (.+)$/; // stderr; LOCAL_ERROR (§6.1)

const IGNORE: readonly RegExp[] = [
  /^PING /,
  /^--- .* ---$/,
  /^\d+ packets transmitted/,
  /^round-trip/,
  // ICMP error notices (`76 bytes from 67.87.20.1: Communication prohibited by filter`) and the
  // IP header dump macOS prints under them. The `Request timeout` line for that seq still follows,
  // so these are neither loss nor probe errors (observed on this machine; see fixtures).
  /^\d+ bytes from [\d.]+: (?!icmp_seq=)/,
  /^Vr HL TOS\s+Len\s+ID/,
  /^\s*\d+\s+\d+\s+[0-9a-f]{2}\s+[0-9a-f]{4}\s+[0-9a-f]{4}\s/,
];

export function parsePingLine(raw: string): PingEvent {
  const line = raw.trimEnd();
  if (line.trim() === '') return { kind: 'ignore' };
  const r = REPLY.exec(line);
  if (r) return { kind: 'reply', seq: Number(r[3]), rttMs: Number(r[5]), dup: r[6] !== undefined };
  const t = TIMEOUT.exec(line);
  if (t) return { kind: 'timeout', seq: Number(t[1]) };
  const e = SENDTO.exec(line);
  if (e) return { kind: 'error', reason: (e[1] ?? '').trim() };
  for (const re of IGNORE) if (re.test(line)) return { kind: 'ignore' };
  return { kind: 'unknown', line }; // counted in errs, logged, never loss
}
