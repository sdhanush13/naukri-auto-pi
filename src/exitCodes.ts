/** Process exit codes. systemd, scripts/status.sh and the notifier all rely on these values. */
export const ExitCode = {
  Success: 0,
  Failure: 1,
  ManualLogin: 2,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Hard cap: never more than this many real (non-dry-run) attempts per calendar day. */
export const MAX_ATTEMPTS_PER_DAY = 2;

/** A failure in a named step of the flow (exit code 1, eligible for the single retry). */
export class StepError extends Error {
  readonly step: string;
  constructor(step: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StepError';
    this.step = step;
  }
}

/**
 * Naukri wants a human: OTP, CAPTCHA, other verification, rejected credentials,
 * or no credentials and no valid session. Exit code 2, never retried, never "solved".
 */
export class ManualLoginRequired extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Manual login needed: ${reason}`);
    this.name = 'ManualLoginRequired';
    this.reason = reason;
  }
}

export function exitCodeFor(err: unknown): ExitCodeValue {
  return err instanceof ManualLoginRequired ? ExitCode.ManualLogin : ExitCode.Failure;
}

/** Only plain failures are retried, only once, and never in dry-run mode. */
export function shouldRetry(
  code: ExitCodeValue,
  attempt: number,
  opts: { dryRun: boolean; maxAttempts?: number },
): boolean {
  const max = opts.maxAttempts ?? MAX_ATTEMPTS_PER_DAY;
  return code === ExitCode.Failure && !opts.dryRun && attempt < max;
}

export function describeExitCode(code: number): string {
  switch (code) {
    case ExitCode.Success:
      return 'success';
    case ExitCode.Failure:
      return 'failure';
    case ExitCode.ManualLogin:
      return 'manual login required';
    default:
      return `unknown (${code})`;
  }
}
