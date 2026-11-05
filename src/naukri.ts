import { basename, join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { newRunDir, pruneArtifacts } from './artifacts.js';
import type { Config } from './config.js';
import { ExitCode, exitCodeFor, ManualLoginRequired, StepError } from './exitCodes.js';
import type { Logger } from './logger.js';
import type { AttemptResult } from './retry.js';
import * as sel from './selectors.js';
import { ensureLoggedIn, loadStorageState, saveStorageState, statePath } from './session.js';

export interface RunOptions {
  dryRun: boolean;
  log: Logger;
  /** Chromium's own sandbox. Off inside Docker (the container is the sandbox), on natively. */
  chromiumSandbox: boolean;
}

/** Wraps a step so any Playwright error is reported with the step name. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepError || err instanceof ManualLoginRequired) throw err;
    throw new StepError(name, (err as Error).message, { cause: err });
  }
}

export async function uploadResume(page: Page, cfg: Config): Promise<void> {
  const input = sel.profile.resumeInput(page).first();
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles(cfg.resumePath);
  await sel.visible(sel.profile.uploadSuccess(page)).waitFor({ state: 'visible', timeout: cfg.timeouts.uploadMs });
}

async function editSection(
  page: Page,
  editButton: ReturnType<typeof sel.profile.headlineEdit>,
  input: ReturnType<typeof sel.profile.headlineInput>,
  value: string,
): Promise<void> {
  await sel.visible(editButton).click();
  const box = sel.visible(input);
  await box.waitFor({ state: 'visible' });
  await box.fill(value);
  await sel.visible(sel.profile.saveButton(page)).click();
  await box.waitFor({ state: 'hidden' });
  // The saved text must now be on the page (prefix: long summaries get a "read more").
  await sel.visible(page.getByText(value.slice(0, 60))).waitFor({ state: 'visible' });
}

export async function updateHeadline(page: Page, headline: string): Promise<void> {
  await editSection(page, sel.profile.headlineEdit(page), sel.profile.headlineInput(page), headline);
}

export async function updateSummary(page: Page, summary: string): Promise<void> {
  await editSection(page, sel.profile.summaryEdit(page), sel.profile.summaryInput(page), summary);
}

/** Reload so we check what Naukri stored, not what the page optimistically shows. */
export async function verifyUpdatedToday(page: Page, cfg: Config, log: Logger): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sel.visible(sel.profile.marker(page)).waitFor({ state: 'visible', timeout: cfg.timeouts.navigationMs });
  await sel.visible(sel.profile.lastUpdatedToday(page)).waitFor({ state: 'visible' });
  const file = basename(cfg.resumePath);
  if (!(await sel.visible(sel.profile.fileName(page, file)).isVisible())) {
    // Naukri sometimes truncates or renames the displayed filename; "updated today" is the real check.
    log.warn({ file }, 'uploaded filename not visible on profile page');
  }
}

export function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip ANSI colours and Playwright's multi-line call logs; keep the first useful line.
  const firstLine = raw.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0] ?? raw;
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}

/** One attempt of the whole flow. Never throws; always returns an exit code. */
export async function runRefresh(cfg: Config, opts: RunOptions): Promise<AttemptResult> {
  const { log } = opts;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let current = 'launch';
  let tracing = false;
  const done: string[] = [];

  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: opts.chromiumSandbox });
    context = await browser.newContext({
      storageState: await loadStorageState(statePath(cfg.stateDir)),
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultTimeout(cfg.timeouts.actionMs);
    context.setDefaultNavigationTimeout(cfg.timeouts.navigationMs);
    page = await context.newPage();

    current = 'session';
    const how = await step('session', () => ensureLoggedIn(page!, cfg, log));
    await saveStorageState(context, statePath(cfg.stateDir));

    if (opts.dryRun) {
      current = 'dry-run';
      const dir = await newRunDir(cfg.stateDir, 'dry-run');
      await page.screenshot({ path: join(dir, 'profile.png'), fullPage: true });
      await pruneArtifacts(cfg.stateDir);
      return {
        code: ExitCode.Success,
        message: `Dry run OK (${how === 'session' ? 'saved session valid' : 'logged in'}); nothing changed. Screenshot: ${dir}`,
        artifactDir: dir,
      };
    }

    // Tracing starts only after login, so the trace never records the password being typed.
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;

    current = 'upload';
    await step('upload', () => uploadResume(page!, cfg));
    done.push(`resume uploaded (${basename(cfg.resumePath)})`);

    if (cfg.headline) {
      current = 'headline';
      await step('headline', () => updateHeadline(page!, cfg.headline!));
      done.push('headline updated');
    }
    if (cfg.summary) {
      current = 'summary';
      await step('summary', () => updateSummary(page!, cfg.summary!));
      done.push('summary updated');
    }

    current = 'verify';
    await step('verify', () => verifyUpdatedToday(page!, cfg, log));

    current = 'save-session';
    await saveStorageState(context, statePath(cfg.stateDir));
    await context.tracing.stop();
    tracing = false;

    return { code: ExitCode.Success, message: `${done.join(', ')}; profile shows updated today` };
  } catch (err) {
    const code = exitCodeFor(err);
    const failedStep = err instanceof StepError ? err.step : current;
    log.error({ step: failedStep, code, error: cleanMessage(err) }, 'attempt failed');
    let dir: string | undefined;
    try {
      dir = await newRunDir(cfg.stateDir, code === ExitCode.ManualLogin ? 'manual-login' : failedStep);
      if (page) await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => undefined);
      if (context && tracing) await context.tracing.stop({ path: join(dir, 'trace.zip') }).catch(() => undefined);
      await pruneArtifacts(cfg.stateDir);
    } catch (artifactErr) {
      log.warn({ error: cleanMessage(artifactErr) }, 'could not save failure artifacts');
    }
    return { code, step: failedStep, message: cleanMessage(err), artifactDir: dir };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
