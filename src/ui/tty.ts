// §8.3 terminal handling. Side-effecting: stdout escapes, raw mode, resize/key events, timers.
import { monoNow } from '../core/clock';
import { CSI } from './ansi';
import { FrameGate } from './frame';
import type { Size } from './layout';
import { installShutdownHandlers, onRestore, shutdown } from './shutdown';

export { onShutdown, shutdown, installShutdownHandlers, isShuttingDown } from './shutdown';

export type KeyHandler = (key: string) => void;
export type ResizeHandler = (size: Size) => void;
export interface TtyHandlers { onKey?: KeyHandler; onResize?: ResizeHandler }

const DEFAULT_SIZE: Size = { cols: 80, rows: 24 };

export class Tty {
  private entered = false;
  private restoreRegistered = false;
  private keyHandlers: KeyHandler[] = [];
  private resizeHandlers: ResizeHandler[] = [];
  private lastSize: Size = DEFAULT_SIZE;
  private readonly gate = new FrameGate();
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onData = (chunk: Buffer | string): void => this.handleData(chunk);
  private readonly onResizeEvent = (): void => { this.pollResize(); };

  /** §8.3: TUI needs a TTY stdout and stdin.setRawMode; checked before any escape is written. */
  canTui(): boolean {
    return process.stdout.isTTY === true && typeof process.stdin.setRawMode === 'function';
  }

  get active(): boolean {
    return this.entered;
  }

  size(): Size {
    const cols = Number(process.stdout.columns);
    const rows = Number(process.stdout.rows);
    return {
      cols: cols > 0 ? Math.floor(cols) : DEFAULT_SIZE.cols,
      rows: rows > 0 ? Math.floor(rows) : DEFAULT_SIZE.rows,
    };
  }

  onKey(fn: KeyHandler): void {
    this.keyHandlers.push(fn);
  }

  onResize(fn: ResizeHandler): void {
    this.resizeHandlers.push(fn);
  }

  /** Alt screen + hidden cursor + raw mode; installs the shutdown bindings. Idempotent. */
  enter(h: TtyHandlers = {}): void {
    if (h.onKey) this.onKey(h.onKey);
    if (h.onResize) this.onResize(h.onResize);
    if (this.entered) return;
    if (!this.canTui()) throw new Error('Tty.enter: stdout/stdin is not a TTY (use plain mode)');
    installShutdownHandlers();
    if (!this.restoreRegistered) {
      this.restoreRegistered = true;
      onRestore(() => this.leave());
    }
    this.entered = true;
    // Raw mode first: setRawMode() is a tcsetattr() that drains queued output before switching, so
    // it is done before any escape is queued (a slow pty reader would otherwise stall it).
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.onData);
    this.lastSize = this.size();
    this.raw(CSI.ALT_ON + CSI.CURSOR_HIDE + CSI.CLEAR_SCREEN); // one clear on entry only
    process.stdout.on('resize', this.onResizeEvent);
  }

  /** Cursor back, alt screen off, raw mode off, listeners removed. Idempotent. */
  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    process.stdin.off('data', this.onData);
    process.stdout.off('resize', this.onResizeEvent);
    this.raw(CSI.RESET + CSI.CURSOR_SHOW + CSI.ALT_OFF);
    try {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    } catch {
      // stdin already closed (SIGHUP)
    }
  }

  /**
   * Write one frame (from renderFrame) with a single stdout.write, capped at MAX_FPS: a frame
   * arriving too soon is held and the latest one is written when the gap has elapsed.
   */
  write(frame: string): void {
    if (!this.entered) return;
    const wait = this.gate.delay(monoNow());
    if (wait <= 0) {
      this.raw(frame);
      return;
    }
    this.pending = frame;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const f = this.pending;
      this.pending = null;
      if (f === null || !this.entered) return;
      this.gate.mark(monoNow());
      this.raw(f);
    }, wait);
  }

  /** Belt-and-braces resize check (§8.3): call every tick; fires onResize when the size changed. */
  pollResize(): boolean {
    const s = this.size();
    if (s.cols === this.lastSize.cols && s.rows === this.lastSize.rows) return false;
    this.lastSize = s;
    for (const h of this.resizeHandlers) h(s);
    return true;
  }

  private raw(s: string): void {
    try {
      process.stdout.write(s);
    } catch {
      // EPIPE/EIO: terminal went away; shutdown handles the rest
    }
  }

  private handleData(chunk: Buffer | string): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (s.length === 0) return;
    // Ctrl-C reaches us as \x03 in raw mode; with no key binding yet it must still quit.
    if (s.includes('\x03') && this.keyHandlers.length === 0) {
      shutdown('SIGINT');
      return;
    }
    if (s.startsWith('\x1b')) return; // CSI/SS3 sequences (arrows, mouse): no bound key uses them (§8.4)
    for (const ch of s) for (const h of this.keyHandlers) h(ch);
  }
}
