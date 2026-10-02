// §12 parsed command-line options.
export interface Options {
  target: string; // --target <ip> (default 1.1.1.1)
  iface: string | null; // --iface <name>, null = networksetup lookup
  log: string | null; // resolved JSONL path; bare --log resolves to ~/netmon-YYYYMMDD-HHMM.jsonl at parse time; null = off
  portalUrl: string | null; // --portal-url for the `o` key when no redirect was captured
  plain: boolean; // --plain
  advanced: boolean; // --advanced: start in the advanced (detailed) view
  ascii: boolean; // --ascii
  color: boolean; // false with --no-color or NO_COLOR env
  bell: boolean; // false with --no-bell
  help: boolean; // --help (main prints usage() and exits 0)
}
