// §9 `run()` as seen by the one-shot pollers. A structural mirror of core/proc's
// RunResult so tests can inject a fake runner; the real `run` is assignable to RunFn.
import { run } from '../core/proc';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  err?: 'ENOENT' | 'SPAWN';
}

export type RunFn = (argv: string[], timeoutMs: number) => Promise<RunResult>;

export const defaultRun: RunFn = run;
