import { describe, expect, it, vi } from 'vitest';
import {
  describeExitCode,
  ExitCode,
  exitCodeFor,
  ManualLoginRequired,
  shouldRetry,
  StepError,
} from '../../src/exitCodes.js';
import { type AttemptResult, runWithRetry } from '../../src/retry.js';

describe('exit codes', () => {
  it('maps errors to codes', () => {
    expect(exitCodeFor(new ManualLoginRequired('otp'))).toBe(2);
    expect(exitCodeFor(new StepError('upload', 'boom'))).toBe(1);
    expect(exitCodeFor(new Error('x'))).toBe(1);
    expect(exitCodeFor('weird')).toBe(1);
  });

  it('describes codes', () => {
    expect(describeExitCode(0)).toBe('success');
    expect(describeExitCode(1)).toBe('failure');
    expect(describeExitCode(2)).toBe('manual login required');
  });

  it('retries only plain failures, once, never in dry-run', () => {
    expect(shouldRetry(ExitCode.Failure, 1, { dryRun: false })).toBe(true);
    expect(shouldRetry(ExitCode.Failure, 2, { dryRun: false })).toBe(false);
    expect(shouldRetry(ExitCode.ManualLogin, 1, { dryRun: false })).toBe(false);
    expect(shouldRetry(ExitCode.Success, 1, { dryRun: false })).toBe(false);
    expect(shouldRetry(ExitCode.Failure, 1, { dryRun: true })).toBe(false);
  });
});

const ok: AttemptResult = { code: 0, message: 'done' };
const fail: AttemptResult = { code: 1, step: 'upload', message: 'timeout' };
const manual: AttemptResult = { code: 2, step: 'session', message: 'otp' };

function deps(results: AttemptResult[], allowed = Infinity) {
  let claims = 0;
  return {
    runOnce: vi.fn(async () => results.shift() ?? ok),
    claimAttempt: vi.fn(async () => ++claims <= allowed),
    wait: vi.fn(async () => undefined),
  };
}

describe('runWithRetry', () => {
  it('succeeds first time without waiting', async () => {
    const d = deps([ok]);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 5 })).toMatchObject({ code: 0, attempts: 1 });
    expect(d.wait).not.toHaveBeenCalled();
  });

  it('retries a failure exactly once', async () => {
    const d = deps([fail, ok]);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 5 })).toMatchObject({ code: 0, attempts: 2 });
    expect(d.wait).toHaveBeenCalledWith(5);
  });

  it('gives up after two failures', async () => {
    const d = deps([fail, fail, ok]);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 0 })).toMatchObject({ code: 1, attempts: 2 });
    expect(d.runOnce).toHaveBeenCalledTimes(2);
  });

  it('never retries exit code 2', async () => {
    const d = deps([manual, ok]);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 0 })).toMatchObject({ code: 2, attempts: 1 });
    expect(d.runOnce).toHaveBeenCalledTimes(1);
  });

  it('never retries a dry run and does not count it against the daily cap', async () => {
    const d = deps([fail, ok]);
    expect(await runWithRetry(d, { dryRun: true, retryDelayMs: 0 })).toMatchObject({ code: 1, attempts: 1 });
    expect(d.claimAttempt).not.toHaveBeenCalled();
  });

  it('refuses to run when the daily cap is used up', async () => {
    const d = deps([ok], 0);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 0 })).toMatchObject({
      code: 1,
      step: 'daily-cap',
      attempts: 0,
    });
    expect(d.runOnce).not.toHaveBeenCalled();
  });

  it('skips the retry when only one attempt is left today', async () => {
    const d = deps([fail, ok], 1);
    expect(await runWithRetry(d, { dryRun: false, retryDelayMs: 0 })).toMatchObject({
      code: 1,
      step: 'upload',
      attempts: 1,
    });
    expect(d.runOnce).toHaveBeenCalledTimes(1);
  });
});
