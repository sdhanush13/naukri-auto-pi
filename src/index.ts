#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkResumeFile, type Config, DEFAULT_CONFIG_PATH, loadConfig } from './config.js';
import { claimDailyAttempt } from './dailyCap.js';
import { describeExitCode, ExitCode, type ExitCodeValue } from './exitCodes.js';
import { acquireLock } from './lock.js';
import { type Logger, logger } from './logger.js';
import { runApply } from './apply/run.js';
import { rehearse } from './apply/rehearse.js';
import { cleanMessage, runRefresh } from './naukri.js';
import { healthcheck, notify, type NotifyStatus } from './notify.js';
import { type AttemptResult, runWithRetry } from './retry.js';

const HELP = `Usage: naukri-refresher [--task refresh|apply|rehearse] [--dry-run] [--config <path>]

  --task refresh   (default) re-upload the resume, update headline/summary.
  --task apply     search jobs and apply (config "apply"; dry-run until apply.autoFrom).
  --task rehearse  print the answers the apply task would give to sample questions; no browser.

  --dry-run        Restore the session (or log in), screenshot the profile page, change nothing.
                   Also enabled by NAUKRI_DRY_RUN=1 (used by scripts/run-now.sh --dry-run).
  --config <path>  Config file (default: $NAUKRI_CONFIG or ${DEFAULT_CONFIG_PATH})

Exit codes: 0 success, 1 failure, 2 manual login required.`;

function statusFor(code: ExitCodeValue, dryRun: boolean): NotifyStatus {
  if (code === ExitCode.ManualLogin) return 'manual';
  if (code !== ExitCode.Success) return 'failure';
  return dryRun ? 'dry-run' : 'success';
}

function messageFor(result: AttemptResult & { attempts: number }): string {
  if (result.code === ExitCode.Success) return result.message;
  if (result.code === ExitCode.ManualLogin) {
    return `${result.message}. On your laptop run "npm run manual-login", then copy state.json to the Pi (see README).`;
  }
  const where = result.artifactDir ? ` Artifacts: ${result.artifactDir}` : '';
  return `Failed at step "${result.step ?? 'unknown'}" after ${result.attempts} attempt(s): ${result.message}.${where}`;
}

async function writeLastRun(cfg: Config, result: AttemptResult & { attempts: number }, dryRun: boolean): Promise<void> {
  const record = { finishedAt: new Date().toISOString(), dryRun, ...result, outcome: describeExitCode(result.code) };
  await writeFile(join(cfg.stateDir, 'last-run.json'), JSON.stringify(record, null, 2), { mode: 0o600 }).catch(
    () => undefined,
  );
}

export async function main(argv: string[], log: Logger = logger): Promise<ExitCodeValue> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        task: { type: 'string', default: 'refresh' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    log.error({ error: (err as Error).message }, 'bad arguments');
    return ExitCode.Failure;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return ExitCode.Success;
  }

  const dryRun = args['dry-run'] === true || process.env.NAUKRI_DRY_RUN === '1';
  const configPath = args.config ?? process.env.NAUKRI_CONFIG ?? DEFAULT_CONFIG_PATH;

  let cfg: Config;
  try {
    cfg = await loadConfig(configPath);
  } catch (err) {
    // Without a valid config there is no notifier; systemd marks the unit failed and journald has this.
    log.error({ error: (err as Error).message }, 'config invalid');
    return ExitCode.Failure;
  }

  const task = args.task;
  if (task !== 'refresh' && task !== 'apply' && task !== 'rehearse') {
    log.error({ task }, '--task must be refresh, apply or rehearse');
    return ExitCode.Failure;
  }
  if (task === 'rehearse') return rehearse(cfg, log);
  const isApply = task === 'apply';

  log.info({ dryRun, configPath, task }, 'naukri-refresher starting');
  // healthchecks.io tracks the refresher's schedule; the apply task doesn't ping it.
  if (!dryRun && !isApply) await healthcheck(cfg, 'start', log);

  const finish = async (result: AttemptResult & { attempts: number }): Promise<ExitCodeValue> => {
    const message = messageFor(result);
    log[result.code === ExitCode.Success ? 'info' : 'error'](
      { code: result.code, outcome: describeExitCode(result.code), step: result.step, attempts: result.attempts },
      message,
    );
    if (!isApply) await writeLastRun(cfg, result, dryRun);
    const title = isApply
      ? result.code === ExitCode.Success
        ? 'Naukri auto-apply'
        : result.code === ExitCode.ManualLogin
          ? 'Naukri: manual login needed'
          : 'Naukri auto-apply failed'
      : undefined;
    await notify(cfg, { status: statusFor(result.code, dryRun), message, title }, log);
    if (!dryRun && !isApply) await healthcheck(cfg, result.code === ExitCode.Success ? 'success' : 'fail', log, message);
    return result.code;
  };

  try {
    if (!isApply) await checkResumeFile(cfg.resumePath);
  } catch (err) {
    return finish({ code: ExitCode.Failure, step: 'resume-check', message: cleanMessage(err), attempts: 0 });
  }

  let release: () => void;
  try {
    release = acquireLock(join(cfg.stateDir, 'run.lock'));
  } catch (err) {
    return finish({ code: ExitCode.Failure, step: 'lock', message: cleanMessage(err), attempts: 0 });
  }
  const onSignal = (sig: NodeJS.Signals): void => {
    log.warn({ signal: sig }, 'terminated');
    release();
    process.exit(ExitCode.Failure);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    const chromiumSandbox = process.env.NAUKRI_IN_DOCKER !== '1' && process.env.NAUKRI_CHROMIUM_SANDBOX !== '0';
    if (isApply) {
      const r = await runApply(cfg, { dryRun, log, chromiumSandbox });
      return await finish({ ...r, attempts: 1 });
    }
    const result = await runWithRetry(
      {
        runOnce: (attempt) => {
          log.info({ attempt }, 'attempt starting');
          return runRefresh(cfg, { dryRun, log, chromiumSandbox });
        },
        claimAttempt: () => claimDailyAttempt(cfg.stateDir, new Date(), cfg.maxAttemptsPerDay),
        wait: (ms) => delay(ms),
        onRetry: (r, attempt) =>
          log.warn({ attempt, step: r.step, retryInSeconds: cfg.retryDelaySeconds }, 'attempt failed; retrying once'),
      },
      { dryRun, retryDelayMs: cfg.retryDelaySeconds * 1000, maxAttemptsPerDay: cfg.maxAttemptsPerDay },
    );
    return await finish(result);
  } finally {
    release();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      logger.fatal({ error: cleanMessage(err) }, 'unexpected crash');
      process.exit(ExitCode.Failure);
    },
  );
}
