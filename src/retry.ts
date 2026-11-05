import { ExitCode, type ExitCodeValue, MAX_ATTEMPTS_PER_DAY, shouldRetry } from './exitCodes.js';

export interface AttemptResult {
  code: ExitCodeValue;
  /** Step that failed (absent on success). */
  step?: string;
  message: string;
  artifactDir?: string;
}

export interface RetryDeps {
  runOnce(attempt: number): Promise<AttemptResult>;
  /** Records a real attempt for today; false if the daily cap is used up. */
  claimAttempt(): Promise<boolean>;
  wait(ms: number): Promise<void>;
  onRetry?(result: AttemptResult, attempt: number): void;
}

/**
 * In-app retry policy (chosen over systemd Restart=):
 *  - at most one retry, only for exit code 1, never for exit code 2, never in dry-run;
 *  - each real attempt is counted against the per-day cap (2), so the timer, a catch-up
 *    run and manual runs together can never exceed 2 attempts in a day.
 */
export async function runWithRetry(
  deps: RetryDeps,
  opts: { dryRun: boolean; retryDelayMs: number },
): Promise<AttemptResult & { attempts: number }> {
  let previous: AttemptResult | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_DAY; attempt++) {
    if (!opts.dryRun && !(await deps.claimAttempt())) {
      if (previous) return { ...previous, attempts: attempt - 1 };
      return {
        code: ExitCode.Failure,
        step: 'daily-cap',
        message: `Daily limit of ${MAX_ATTEMPTS_PER_DAY} attempts already used; not running again today`,
        attempts: 0,
      };
    }
    const result = await deps.runOnce(attempt);
    if (!shouldRetry(result.code, attempt, { dryRun: opts.dryRun })) return { ...result, attempts: attempt };
    deps.onRetry?.(result, attempt);
    previous = result;
    await deps.wait(opts.retryDelayMs);
  }
  // Unreachable: shouldRetry is false on the last allowed attempt.
  return { ...(previous as AttemptResult), attempts: MAX_ATTEMPTS_PER_DAY };
}
