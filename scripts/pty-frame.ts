// Dev tool: reconstruct the last TUI frame from a captured pty stream (see tests/tui-pty.test.ts for
// the expect harness). Usage: bun run scripts/pty-frame.ts <captured.out>
const raw = await Bun.file(process.argv[2]!).text();
const homes = raw.split("\x1b[H");
const last = homes[homes.length - 1] ?? "";
// find the alt-screen exit to separate the quit report
const altOff = raw.lastIndexOf("\x1b[?1049l");
const after = altOff >= 0 ? raw.slice(altOff + 8) : "";
const rows: string[] = [];
let row = 0, buf = "";
const re = /\x1b\[(\d+);(\d+)H|\x1b\[K|\x1b\[[0-9;?]*[A-Za-z]/g;
let m: RegExpExecArray | null; let idx = 0;
const flush = () => { if (row > 0) rows[row - 1] = (rows[row - 1] ?? "") + buf; buf = ""; };
while ((m = re.exec(last))) {
  buf += last.slice(idx, m.index); idx = m.index + m[0].length;
  if (m[1]) { flush(); row = Number(m[1]); }
}
buf += last.slice(idx); flush();
console.log(`frames=${homes.length - 1} rows=${rows.length}`);
rows.forEach((r, i) => console.log(String(i + 1).padStart(2) + "|" + r.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")));
console.log("=== after alt screen (quit report) ===");
console.log(after.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim());
