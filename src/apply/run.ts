import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, chromium, type Page } from 'playwright';
import { newRunDir, pruneArtifacts } from '../artifacts.js';
import type { ApplyConfig, Config } from '../config.js';
import { localDate } from '../dailyCap.js';
import { ExitCode, exitCodeFor, StepError } from '../exitCodes.js';
import type { Logger } from '../logger.js';
import { cleanMessage, type RunOptions } from '../naukri.js';
import type { AttemptResult } from '../retry.js';
import { ensureLoggedIn, loadStorageState, saveStorageState, statePath } from '../session.js';
import { loadAnswers } from './answers.js';
import { applyToJob } from './applyJob.js';
import { isEligible, type JobRecord, loadHistory, saveHistory } from './history.js';
import { ollamaAsker } from './llm.js';
import { filterReason, type JobCard, readCards, searchUrl } from './search.js';

/** "auto" before autoFrom counts as a dry run (the agreed trial week). */
export function effectiveMode(a: ApplyConfig, now: Date, forceDry: boolean): 'off' | 'dry-run' | 'auto' {
  if (a.mode === 'off') return 'off';
  if (forceDry || a.mode === 'dry-run') return 'dry-run';
  if (a.autoFrom && localDate(now) < a.autoFrom) return 'dry-run';
  return 'auto';
}

const MAX_CONSECUTIVE_FAILURES = 3;
const NOTIFY_LIMIT = 3500; // ntfy messages are capped at 4 KB

async function collectCards(page: Page, cfg: Config, a: ApplyConfig, log: Logger): Promise<JobCard[]> {
  const seen = new Map<string, JobCard>();
  for (const s of a.searches) {
    const url = searchUrl(cfg.baseUrl, s, a.experienceYears, a.jobAgeDays);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Results, or nothing found: either way wait a moment for the client-side render.
    await page.locator('div.srp-jobtuple-wrapper').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    const cards = await readCards(page);
    log.info({ search: s.keywords, location: s.location ?? null, remote: s.remote, found: cards.length }, 'search done');
    for (const c of cards) if (!seen.has(c.id)) seen.set(c.id, c);
    await delay(a.pauseSeconds * 1000);
  }
  return [...seen.values()];
}

export async function runApply(cfg: Config, opts: RunOptions, now = new Date()): Promise<AttemptResult> {
  const { log } = opts;
  const a = cfg.apply;
  if (!a) return { code: ExitCode.Failure, step: 'config', message: 'no "apply" section in config.json' };
  const mode = effectiveMode(a, now, opts.dryRun);
  if (mode === 'off') return { code: ExitCode.Success, message: 'auto-apply is off (apply.mode)' };
  const dry = mode === 'dry-run';

  let browser: Browser | undefined;
  let page: Page | undefined;
  let current = 'answers';
  try {
    const { answers, hash } = await loadAnswers(a.answersPath);
    const ask = a.llm ? ollamaAsker(a.llm) : undefined;
    const history = await loadHistory(cfg.stateDir, now);
    const budget = a.maxPerDay - history.daily.applied;
    if (!dry && budget <= 0) {
      return { code: ExitCode.Success, message: `Daily limit of ${a.maxPerDay} applications already reached` };
    }

    current = 'launch';
    const headless = cfg.browserMode !== 'headed';
    if (!headless && process.platform === 'linux' && !process.env.DISPLAY) {
      throw new StepError('launch', 'browserMode "headed" needs a display; run under xvfb-run');
    }
    browser = await chromium.launch({ headless, chromiumSandbox: opts.chromiumSandbox });
    const context = await browser.newContext({
      storageState: await loadStorageState(statePath(cfg.stateDir)),
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultTimeout(cfg.timeouts.actionMs);
    context.setDefaultNavigationTimeout(cfg.timeouts.navigationMs);
    page = await context.newPage();

    current = 'session';
    await ensureLoggedIn(page, cfg, log);
    await saveStorageState(context, statePath(cfg.stateDir));

    current = 'search';
    const cards = await collectCards(page, cfg, a, log);

    current = 'apply';
    const record = (c: JobCard, r: Omit<JobRecord, 'title' | 'company' | 'url' | 'at'>): void => {
      history.jobs[c.id] = { title: c.title, company: c.company, url: c.url, at: new Date().toISOString(), ...r };
    };
    const lines = { applied: [] as string[], would: [] as string[], skipped: [] as string[], external: 0, filtered: 0, failed: [] as string[] };
    let failures = 0;
    let stopReason = '';
    const limit = dry ? a.maxPerDay : budget;

    for (const c of cards) {
      if (lines.applied.length + lines.would.length >= limit) break;
      if (!isEligible(history, c.id, hash)) continue;
      const why = filterReason(c, a);
      if (why) {
        lines.filtered++;
        record(c, { status: 'filtered', reason: why });
        continue;
      }
      const label = `${c.title} @ ${c.company}`;
      try {
        const out = await applyToJob(page, c.url, { answers, ask, log, timeoutMs: cfg.timeouts.actionMs, dryRun: dry });
        failures = 0;
        switch (out.status) {
          case 'applied':
            history.daily.applied++;
            lines.applied.push(label);
            record(c, { status: 'applied', reason: out.questions.join(' | ') || undefined });
            break;
          case 'would-apply':
            lines.would.push(`${label} ${c.url}`);
            record(c, { status: 'would-apply' });
            break;
          case 'external':
            lines.external++;
            record(c, { status: 'external', reason: out.reason });
            break;
          case 'already-applied':
            record(c, { status: 'already-applied' });
            break;
          case 'skipped-question':
            lines.skipped.push(`${label}: "${out.question}" (${out.reason})`);
            record(c, { status: 'skipped-question', reason: `${out.question}: ${out.reason}`, answersHash: hash });
            break;
          case 'quota':
            stopReason = out.reason;
            break;
          case 'failed':
            failures++;
            lines.failed.push(`${label}: ${out.reason}`);
            record(c, { status: 'failed', reason: out.reason });
            break;
        }
      } catch (err) {
        failures++;
        lines.failed.push(`${label}: ${cleanMessage(err)}`);
        record(c, { status: 'failed', reason: cleanMessage(err) });
        const dir = await newRunDir(cfg.stateDir, `apply-${c.id}`);
        await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => undefined);
      }
      await saveHistory(cfg.stateDir, history);
      if (stopReason) break;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `${failures} jobs in a row failed; stopping (selectors may have changed)`;
        break;
      }
      await delay(a.pauseSeconds * 1000);
    }

    await saveStorageState(context, statePath(cfg.stateDir));
    await saveHistory(cfg.stateDir, history);

    const dir = await newRunDir(cfg.stateDir, dry ? 'apply-dry-run' : 'apply');
    await writeFile(join(dir, 'report.json'), JSON.stringify({ mode, cards: cards.length, ...lines, stopReason }, null, 2), { mode: 0o600 });
    await pruneArtifacts(cfg.stateDir);

    const parts: string[] = [];
    if (dry) {
      const until = a.mode === 'auto' && a.autoFrom ? ` (auto-apply starts ${a.autoFrom})` : '';
      parts.push(`DRY RUN${until}: would apply to ${lines.would.length} of ${cards.length} jobs found.`);
      parts.push(...lines.would.map((l) => `• ${l}`));
    } else {
      parts.push(`Applied to ${lines.applied.length} (today ${history.daily.applied}/${a.maxPerDay}) of ${cards.length} jobs found.`);
      parts.push(...lines.applied.map((l) => `• ${l}`));
    }
    if (lines.skipped.length) parts.push(`Skipped, no answer (add to answers.json):`, ...lines.skipped.map((l) => `• ${l}`));
    if (lines.external || lines.filtered) parts.push(`${lines.external} on company sites, ${lines.filtered} filtered out.`);
    if (lines.failed.length) parts.push(`Failed:`, ...lines.failed.map((l) => `• ${l}`));
    if (stopReason) parts.push(`Stopped: ${stopReason}`);
    let message = parts.join('\n');
    if (message.length > NOTIFY_LIMIT) message = `${message.slice(0, NOTIFY_LIMIT)}\n… (full list in ${dir}/report.json)`;

    const broken = lines.failed.length > 0 && lines.applied.length + lines.would.length === 0 && failures >= MAX_CONSECUTIVE_FAILURES;
    return { code: broken ? ExitCode.Failure : ExitCode.Success, step: broken ? 'apply' : undefined, message, artifactDir: dir };
  } catch (err) {
    const code = exitCodeFor(err);
    const failedStep = err instanceof StepError ? err.step : current;
    log.error({ step: failedStep, code, error: cleanMessage(err) }, 'apply run failed');
    let dir: string | undefined;
    try {
      dir = await newRunDir(cfg.stateDir, code === ExitCode.ManualLogin ? 'manual-login' : `apply-${failedStep}`);
      if (page) await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => undefined);
      await pruneArtifacts(cfg.stateDir);
    } catch {
      /* best effort */
    }
    return { code, step: failedStep, message: cleanMessage(err), artifactDir: dir };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
