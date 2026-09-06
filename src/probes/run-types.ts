// §9 `run()` contract re-exported for the pollers, plus a test helper.
import type { RunResult } from '../core/proc';

export type { RunResult };

/** Shape of core/proc `run` (§9); pollers accept an injected one for tests. */
export type RunFn = (argv: string[], timeoutMs: number) => Promise<RunResult>;

/** Build a RunResult for tests and fallbacks. */
export function fakeResult(stdout: string, code: number | null = 0, extra: Partial<RunResult> = {}): RunResult {
  return { ok: code === 0 && !extra.timedOut && !extra.err, code, stdout, stderr: '', ms: 0, timedOut: false, ...extra };
}
