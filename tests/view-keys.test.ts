import { test, expect } from 'bun:test';
import { dispatchKey, KEY_VIEW, type KeyActions } from '../src/ui/keys';
import { viewAction } from '../src/app/actions';
import { parseArgs, usage } from '../src/cli/args';
import { makeUi } from './helpers/snapshot';

const env = { env: { HOME: '/Users/test' }, now: new Date(2026, 8, 6, 14, 32, 7) };

const ui = makeUi;

function spy(): { calls: string[]; actions: KeyActions } {
  const calls: string[] = [];
  const actions: KeyActions = {
    quit: () => calls.push('quit'), speed: () => calls.push('speed'), bell: () => calls.push('bell'),
    portal: () => calls.push('portal'), view: () => calls.push('view'),
  };
  return { calls, actions };
}

test('v dispatches the view action; unknown keys are still ignored', () => {
  const { calls, actions } = spy();
  expect(KEY_VIEW).toBe('v');
  expect(dispatchKey('v', actions)).toBe(true);
  expect(dispatchKey('V', actions)).toBe(false);
  expect(dispatchKey('x', actions)).toBe(false);
  expect(calls).toEqual(['view']);
});

test('viewAction toggles simple <-> advanced and repaints each time', () => {
  const state = ui();
  let redraws = 0;
  const ctx = { ui: state, redraw: () => { redraws++; } };
  viewAction(ctx);
  expect([state.view, redraws]).toEqual(['advanced', 1]);
  viewAction(ctx);
  expect([state.view, redraws]).toEqual(['simple', 2]);
});

test('--advanced: off by default, on when given, takes no value', () => {
  expect(parseArgs([], env).advanced).toBe(false);
  expect(parseArgs(['--advanced'], env).advanced).toBe(true);
  expect(() => parseArgs(['--advanced=1'], env)).toThrow('--advanced does not take a value');
});

test('usage() documents --advanced and the v key', () => {
  const u = usage();
  expect(u).toContain('--advanced');
  expect(u).toContain('v simple/advanced view');
});
