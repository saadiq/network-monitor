// §12 hand-rolled flag parser. Pure: env and clock are injectable so tests are deterministic.
import { homedir } from 'node:os';
import { DEFAULT_TARGET, LOG_PREFIX } from '../config';
import type { Options } from './types';

export type { Options } from './types';

/** Thrown for an unknown option, a missing value or a stray positional. main prints message + usage(). */
export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgsError';
  }
}

export interface ParseEnv {
  env?: Record<string, string | undefined>; // default process.env (HOME, NO_COLOR)
  now?: Date; // default new Date(); names the bare --log file
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** §11 default log path: <home>/netmon-YYYYMMDD-HHMM.jsonl (local time). */
export function defaultLogPath(now: Date, home: string): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `${home.replace(/\/$/, '')}/${LOG_PREFIX}${stamp}.jsonl`;
}

/** Expand a leading `~` / `~/` (the shell does not when the path was quoted). */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? `${home.replace(/\/$/, '')}${p.slice(1)}` : p;
}

/**
 * Strict dotted quad (§12 `--target <ip>`): `route -n get` and `ping` take an address, not a name —
 * a hostname there makes every route poll fail and the tool reports NO LINK on a healthy network.
 */
export function isIPv4Address(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** `--name=value` → [name, value]; otherwise [arg, null]. */
function splitInline(arg: string): [string, string | null] {
  if (!arg.startsWith('--')) return [arg, null];
  const eq = arg.indexOf('=');
  return eq < 0 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** Value for a `--flag <value>` option: inline `=value` or the next argv entry (never another flag). */
function requireValue(name: string, inline: string | null, next: string | undefined): { value: string; consumed: boolean } {
  if (inline !== null) {
    if (inline === '') throw new ArgsError(`${name} requires a value`);
    return { value: inline, consumed: false };
  }
  if (next === undefined || next === '' || next.startsWith('-')) throw new ArgsError(`${name} requires a value`);
  return { value: next, consumed: true };
}

/** NO_COLOR is honored when present and non-empty (no-color.org). */
function noColorEnv(env: Record<string, string | undefined>): boolean {
  const v = env['NO_COLOR'];
  return v !== undefined && v !== '';
}

const BOOL_FLAGS: Readonly<Record<string, keyof Options>> = {
  '--plain': 'plain', '--ascii': 'ascii', '--help': 'help', '-h': 'help',
};

export function parseArgs(argv: string[], pe: ParseEnv = {}): Options {
  const env = pe.env ?? process.env;
  const home = env['HOME'] || homedir();
  const o: Options = {
    target: DEFAULT_TARGET, iface: null, log: null, portalUrl: null,
    plain: false, ascii: false, color: !noColorEnv(env), bell: true, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [name, inline] = splitInline(arg);
    const boolKey = BOOL_FLAGS[name];
    if (boolKey !== undefined || name === '--no-color' || name === '--no-bell') {
      if (inline !== null) throw new ArgsError(`${name} does not take a value`);
      if (boolKey === 'plain' || boolKey === 'ascii' || boolKey === 'help') o[boolKey] = true;
      else if (name === '--no-color') o.color = false;
      else o.bell = false;
      continue;
    }
    if (name === '--log') {
      // optional path: inline, or the next entry when it is not a flag (§12)
      if (inline === '') throw new ArgsError('--log requires a value'); // `--log=` is a typo, not "log nowhere"
      const next = argv[i + 1];
      const explicit = inline ?? (next !== undefined && next !== '' && !next.startsWith('-') ? next : null);
      if (explicit !== null && inline === null) i++;
      o.log = expandHome(explicit ?? defaultLogPath(pe.now ?? new Date(), home), home);
      continue;
    }
    if (name === '--target' || name === '--iface' || name === '--portal-url') {
      const { value, consumed } = requireValue(name, inline, argv[i + 1]);
      if (consumed) i++;
      if (name === '--iface') o.iface = value;
      else if (name === '--portal-url') o.portalUrl = value;
      else if (isIPv4Address(value)) o.target = value;
      else throw new ArgsError('--target must be an IPv4 address (e.g. 1.1.1.1)');
      continue;
    }
    if (arg.startsWith('-')) throw new ArgsError(`unknown option: ${arg}`);
    throw new ArgsError(`unexpected argument: ${arg}`);
  }
  return o;
}

/** §12 usage text (trailing newline). */
export function usage(): string {
  return [
    'netmon — in-flight Wi-Fi monitor (macOS)',
    '',
    'Usage: bun run src/main.ts [options]',
    `  --target <ip>        internet ping/route target (default ${DEFAULT_TARGET})`,
    '  --iface <name>       force the Wi-Fi interface (default: networksetup lookup)',
    '  --log [path]         write JSONL (default path ~/netmon-YYYYMMDD-HHMM.jsonl)',
    '  --portal-url <url>   URL for the o key when no redirect was captured',
    '  --plain              one status line per second, no full-screen UI',
    '  --ascii              ASCII glyphs instead of Unicode',
    '  --no-color           no ANSI colors (NO_COLOR env also respected)',
    '  --no-bell            start with the bell off',
    '  --help',
    '',
    'Keys: q quit · t speed test (250 KB) · b bell on/off · o open portal',
    '',
  ].join('\n');
}
