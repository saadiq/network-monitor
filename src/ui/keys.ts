// §8.4 key dispatch. `dispatchKey` is pure; `bindKeys` subscribes it to a key source (Tty).

export interface KeyActions {
  quit(): void; // q, Ctrl-C
  speed(): void; // t — 250 KB speed test (rate limit / state refusal decided by the action)
  bell(): void; // b — toggle bell
  portal(): void; // o — open the portal URL
  view(): void; // v — switch simple/advanced view
}

/** Anything with Tty's onKey; kept minimal so tests need no terminal. */
export interface KeySource { onKey(fn: (key: string) => void): void }

export const KEY_QUIT = 'q';
export const KEY_CTRL_C = '\x03';
export const KEY_SPEED = 't';
export const KEY_BELL = 'b';
export const KEY_PORTAL = 'o';
export const KEY_VIEW = 'v';

/** Run the action for `key`; returns false for unbound keys (ignored, §8.4). */
export function dispatchKey(key: string, actions: KeyActions): boolean {
  switch (key) {
    case KEY_QUIT:
    case KEY_CTRL_C:
      actions.quit();
      return true;
    case KEY_SPEED:
      actions.speed();
      return true;
    case KEY_BELL:
      actions.bell();
      return true;
    case KEY_PORTAL:
      actions.portal();
      return true;
    case KEY_VIEW:
      actions.view();
      return true;
    default:
      return false;
  }
}

export function bindKeys(tty: KeySource, actions: KeyActions): void {
  tty.onKey((key) => {
    dispatchKey(key, actions);
  });
}
