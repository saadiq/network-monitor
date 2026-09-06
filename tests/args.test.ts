import { test, expect } from 'bun:test';
import { ArgsError, defaultLogPath, expandHome, parseArgs, usage } from '../src/cli/args';

const HOME = '/Users/test';
const NOW = new Date(2026, 8, 6, 14, 32, 7); // 2026-09-06 14:32:07 local
const env = (extra: Record<string, string | undefined> = {}) => ({ env: { HOME, ...extra }, now: NOW });

test('defaults (§12)', () => {
  expect(parseArgs([], env())).toEqual({
    target: '1.1.1.1', iface: null, log: null, portalUrl: null,
    plain: false, ascii: false, color: true, bell: true, help: false,
  });
});

test('value flags: separate and --flag=value forms', () => {
  const o = parseArgs(['--target', '8.8.8.8', '--iface', 'en0', '--portal-url', 'http://x/login'], env());
  expect(o.target).toBe('8.8.8.8');
  expect(o.iface).toBe('en0');
  expect(o.portalUrl).toBe('http://x/login');
  const p = parseArgs(['--target=9.9.9.9', '--iface=en1', '--portal-url=http://y'], env());
  expect(p.target).toBe('9.9.9.9');
  expect(p.iface).toBe('en1');
  expect(p.portalUrl).toBe('http://y');
});

test('boolean flags', () => {
  const o = parseArgs(['--plain', '--ascii', '--no-color', '--no-bell', '--help'], env());
  expect(o.plain).toBe(true);
  expect(o.ascii).toBe(true);
  expect(o.color).toBe(false);
  expect(o.bell).toBe(false);
  expect(o.help).toBe(true);
  expect(parseArgs(['-h'], env()).help).toBe(true);
});

test('--log bare resolves to ~/netmon-YYYYMMDD-HHMM.jsonl at parse time', () => {
  expect(parseArgs(['--log'], env()).log).toBe('/Users/test/netmon-20260906-1432.jsonl');
  // a following flag is not swallowed as the path
  const o = parseArgs(['--log', '--plain'], env());
  expect(o.log).toBe('/Users/test/netmon-20260906-1432.jsonl');
  expect(o.plain).toBe(true);
});

test('--log with a path (plain, ~/, inline)', () => {
  expect(parseArgs(['--log', './x.jsonl'], env()).log).toBe('./x.jsonl');
  expect(parseArgs(['--log', '~/a.jsonl'], env()).log).toBe('/Users/test/a.jsonl');
  expect(parseArgs(['--log=~/b.jsonl'], env()).log).toBe('/Users/test/b.jsonl');
  expect(parseArgs(['--log=/abs/c.jsonl', '--plain'], env()).log).toBe('/abs/c.jsonl');
});

test('defaultLogPath pads month/day/hour/minute', () => {
  expect(defaultLogPath(new Date(2026, 0, 3, 7, 5), HOME)).toBe('/Users/test/netmon-20260103-0705.jsonl');
  expect(expandHome('~', HOME)).toBe('/Users/test');
  expect(expandHome('~user/x', HOME)).toBe('~user/x'); // only ~ and ~/ expand
});

test('NO_COLOR env (non-empty) disables color; empty does not', () => {
  expect(parseArgs([], env({ NO_COLOR: '1' })).color).toBe(false);
  expect(parseArgs([], env({ NO_COLOR: 'yes' })).color).toBe(false);
  expect(parseArgs([], env({ NO_COLOR: '' })).color).toBe(true);
  expect(parseArgs(['--no-color'], env({ NO_COLOR: '' })).color).toBe(false);
});

test('last occurrence wins', () => {
  expect(parseArgs(['--target', '1.0.0.1', '--target', '8.8.4.4'], env()).target).toBe('8.8.4.4');
});

test('errors: unknown option, missing value, positional, value on a boolean flag', () => {
  expect(() => parseArgs(['--bogus'], env())).toThrow(ArgsError);
  expect(() => parseArgs(['--bogus'], env())).toThrow('unknown option: --bogus');
  expect(() => parseArgs(['--target'], env())).toThrow('--target requires a value');
  expect(() => parseArgs(['--target', '--plain'], env())).toThrow('--target requires a value');
  expect(() => parseArgs(['--target='], env())).toThrow('--target requires a value');
  expect(() => parseArgs(['--iface'], env())).toThrow(ArgsError);
  expect(() => parseArgs(['--portal-url'], env())).toThrow(ArgsError);
  expect(() => parseArgs(['foo'], env())).toThrow('unexpected argument: foo');
  expect(() => parseArgs(['--plain=1'], env())).toThrow('--plain does not take a value');
});

test('usage() lists every flag', () => {
  const u = usage();
  for (const f of ['--target <ip>', '--iface <name>', '--log [path]', '--portal-url <url>', '--plain', '--ascii', '--no-color', '--no-bell', '--help']) {
    expect(u).toContain(f);
  }
  expect(u).toContain('bun run src/main.ts [options]');
  expect(u.endsWith('\n')).toBe(true);
});

test('--target must be an IPv4 address (route -n get takes an address, not a name)', () => {
  expect(parseArgs(['--target', '8.8.4.4'], env()).target).toBe('8.8.4.4');
  expect(parseArgs(['--target=10.255.255.1'], env()).target).toBe('10.255.255.1');
  expect(parseArgs([], env()).target).toBe('1.1.1.1');
  for (const bad of ['foo', 'nonexistent.invalid', '-1', '1.1.1', '1.1.1.1.1', '999.999.999.999', '1.2.3.256', '1.1.1.01', '::1', '1.1.1.1 ']) {
    expect(() => parseArgs([`--target=${bad}`], env())).toThrow(ArgsError);
    expect(() => parseArgs([`--target=${bad}`], env())).toThrow('--target must be an IPv4 address');
  }
  expect(() => parseArgs(['--target', 'example.com'], env())).toThrow('--target must be an IPv4 address');
});

test('--log= (empty inline value) is rejected, not silently logging to nowhere', () => {
  expect(() => parseArgs(['--log='], env())).toThrow(ArgsError);
  expect(() => parseArgs(['--log='], env())).toThrow('--log requires a value');
  expect(parseArgs(['--log'], env()).log).toBe('/Users/test/netmon-20260906-1432.jsonl'); // bare form still works
  expect(parseArgs(['--log=/tmp/x.jsonl'], env()).log).toBe('/tmp/x.jsonl');
});
