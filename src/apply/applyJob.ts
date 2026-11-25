import type { Locator, Page } from 'playwright';
import type { Logger } from '../logger.js';
import type { AskModel, Answers, Question } from './answers.js';
import { resolveAnswer } from './answers.js';

/**
 * Job page + screening chatbot selectors. Sources (checked 2026-11-11, 5-7 public repos agree on
 * each unless noted): #apply-button, #company-site-button, #already-applied, #walkin-button;
 * chatbot drawer [class*="chatbot_Drawer"], questions in li.botItem .botMsg, text input
 * div.textArea[contenteditable], Save = div.sendMsg, radios .ssrc__radio-btn-container label,
 * checkboxes .mcc__label, chips [class*="chatbot_Chip"] (fewer sources), close .chatBot-ic-cross
 * (one source; Escape as fallback). Success: URL /myapply/saveApply or "successfully applied" /
 * "Applied to". Quota: "Your daily quota has been expired." (one source).
 */
export const jobSel = {
  apply: '#apply-button',
  companySite: '#company-site-button',
  alreadyApplied: '#already-applied',
  walkin: '#walkin-button',
  drawer: '[class*="chatbot_Drawer"]',
  botMsg: 'li.botItem .botMsg',
  textInput: 'div.textArea[contenteditable="true"]',
  send: 'div.sendMsg',
  radioLabel: '.ssrc__radio-btn-container label',
  checkboxLabel: '.mcc__label',
  // The chip itself; [class*="chatbot_Chip"] also matched its .chatbot_Chips container, and a
  // click on the container did nothing (live, 2026-11-23..25).
  chip: '.chatbot_Chip',
  close: '.chatBot-ic-cross',
  successText: /you have successfully applied|applied to\s*["“]|application sent/i,
  quotaText: /daily quota has been (expired|exhausted)/i,
  greeting: /thank you for showing interest|kindly answer all|^hi\b.*\binterest/i,
  done: /thank you for your responses/i,
};

export type ApplyOutcome =
  | { status: 'applied'; questions: string[] }
  | { status: 'would-apply' }
  | { status: 'external'; reason: string }
  | { status: 'already-applied' }
  | { status: 'skipped-question'; reason: string; question: string }
  | { status: 'quota'; reason: string }
  | { status: 'failed'; reason: string };

export interface ApplyDeps {
  answers: Answers;
  ask?: AskModel;
  log: Logger;
  timeoutMs: number;
  dryRun: boolean;
}

const MAX_QUESTIONS = 20;
const SKIP_CHIP = /^skip( this question)?$/i;
const NUMBER_HINT = /\b(how many|number of|no\.? of|years?|yrs?|months?|in days|lpa|ctc|lakhs?|percentage|%|rate|out of)\b/i;

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const s of selectors) if (await page.locator(s).first().isVisible().catch(() => false)) return s;
    await page.waitForTimeout(500);
  }
  return null;
}

async function succeeded(page: Page): Promise<boolean> {
  if (/\/myapply\/saveApply/i.test(page.url())) return true;
  if (await page.getByText(jobSel.successText).first().isVisible().catch(() => false)) return true;
  return page.locator(jobSel.alreadyApplied).first().isVisible().catch(() => false);
}

async function quotaHit(page: Page): Promise<boolean> {
  return page.getByText(jobSel.quotaText).first().isVisible().catch(() => false);
}

/** Last non-empty, non-greeting bot message in the drawer. */
async function lastQuestion(drawer: Locator): Promise<string | null> {
  const msgs = (await drawer.locator(jobSel.botMsg).allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m && !jobSel.greeting.test(m)) return m;
  }
  return null;
}

async function visibleTexts(loc: Locator): Promise<string[]> {
  const out: string[] = [];
  for (const el of await loc.all()) if (await el.isVisible().catch(() => false)) out.push(((await el.textContent()) ?? '').trim());
  return out.filter(Boolean);
}

async function readQuestion(drawer: Locator, text: string): Promise<Question> {
  const radios = await visibleTexts(drawer.locator(jobSel.radioLabel));
  if (radios.length) return { text, kind: 'radio', options: radios };
  const boxes = await visibleTexts(drawer.locator(jobSel.checkboxLabel));
  if (boxes.length) return { text, kind: 'checkbox', options: boxes };
  const chips = [...new Set(await visibleTexts(drawer.locator(jobSel.chip)))];
  const skip = chips.find((c) => SKIP_CHIP.test(c));
  const real = chips.filter((c) => c !== skip);
  if (real.length) return { text, kind: 'radio', options: chips, skip };
  // Only a "Skip this question" chip: a text question the recruiter made optional.
  return { text, kind: NUMBER_HINT.test(text) ? 'number' : 'text', skip };
}

async function submitAnswer(drawer: Locator, q: Question, answer: string): Promise<void> {
  const exact = (loc: Locator) => loc.filter({ hasText: answer }).filter({ visible: true }).first();
  if (q.kind === 'radio' || q.kind === 'checkbox') {
    const chip = exact(drawer.locator(jobSel.chip));
    if (await chip.count()) {
      await chip.click(); // chips send themselves
      return;
    }
    // Click the <label>: input.check() fails on Naukri's custom handler.
    await exact(drawer.locator(q.kind === 'radio' ? jobSel.radioLabel : jobSel.checkboxLabel)).click();
  } else {
    const box = drawer.locator(jobSel.textInput).filter({ visible: true }).first();
    await box.click();
    await box.fill(answer);
  }
  await drawer.locator(jobSel.send).filter({ visible: true }).first().click();
}

async function closeDrawer(page: Page, drawer: Locator): Promise<void> {
  const x = drawer.locator(jobSel.close).first();
  if (await x.isVisible().catch(() => false)) await x.click().catch(() => undefined);
  else await page.keyboard.press('Escape').catch(() => undefined);
}

/** Opens a job page and, unless dry run, applies, answering the screening chatbot if it appears. */
export async function applyToJob(page: Page, url: string, deps: ApplyDeps): Promise<ApplyOutcome> {
  const { log, timeoutMs } = deps;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const state = await firstVisible(
    page,
    [jobSel.alreadyApplied, jobSel.companySite, jobSel.walkin, jobSel.apply],
    timeoutMs,
  );
  if (state === jobSel.alreadyApplied) return { status: 'already-applied' };
  if (state === jobSel.companySite) return { status: 'external', reason: 'apply on company site' };
  if (state === jobSel.walkin) return { status: 'external', reason: 'walk-in job' };
  if (state !== jobSel.apply) return { status: 'failed', reason: 'no Apply button found' };
  if (deps.dryRun) return { status: 'would-apply' };

  // A click before the page's scripts have loaded does nothing (seen live 2026-11-18..20: 16
  // jobs "failed" this way), so wait for load, click the visible button, and retry if nothing
  // happens. Each retry only happens when no chatbot, confirmation or new tab appeared.
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const started = async (): Promise<boolean> =>
    (await page.locator(jobSel.drawer).filter({ visible: true }).count()) > 0 || (await succeeded(page)) || (await quotaHit(page));
  let clicked = false;
  for (let attempt = 1; attempt <= 3 && !clicked; attempt++) {
    // Apply may open the employer's site in a new tab; we never fill in third-party forms.
    const popup = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);
    await page.locator(jobSel.apply).filter({ visible: true }).first().click();
    const opened = await popup;
    if (opened) {
      await opened.close().catch(() => undefined);
      return { status: 'external', reason: 'Apply opened an external site' };
    }
    for (let i = 0; i < 20 && !clicked; i++) {
      clicked = await started();
      if (!clicked) await page.waitForTimeout(500);
    }
    if (!clicked) log.info({ attempt }, 'Apply click had no visible effect yet; retrying');
  }
  if (!clicked) return { status: 'failed', reason: 'Apply button did nothing (3 clicks)' };

  const answered: string[] = [];
  let previous = '';
  // Restarted after every answer: the local model can take minutes on its first question.
  let deadline = Date.now() + timeoutMs * 6;
  while (Date.now() < deadline) {
    try {
    if (await quotaHit(page)) return { status: 'quota', reason: 'Naukri says the daily apply quota is used up' };
    if (await succeeded(page)) return { status: 'applied', questions: answered };

    const drawer = page.locator(jobSel.drawer).filter({ visible: true }).first();
    if (!(await drawer.isVisible().catch(() => false))) {
      await page.waitForTimeout(700);
      continue;
    }
    const text = await lastQuestion(drawer);
    if (!text || text === previous || jobSel.done.test(text)) {
      await page.waitForTimeout(700); // bot still typing, or finishing up
      continue;
    }
    if (answered.length >= MAX_QUESTIONS) {
      await closeDrawer(page, drawer);
      return { status: 'failed', reason: `more than ${MAX_QUESTIONS} questions` };
    }
    await page.waitForTimeout(600); // let the options for this question render
    const q = await readQuestion(drawer, text);
    const res = await resolveAnswer(q, deps.answers, deps.ask);
    if (!res.ok && q.skip) {
      // The recruiter made this question optional ("Skip this question"): skip it, not the job.
      log.info({ question: q.text, kind: q.kind, reason: res.reason }, 'no answer; using "Skip this question"');
      await drawer.locator(jobSel.chip).filter({ hasText: q.skip }).filter({ visible: true }).first().click();
      answered.push(`${q.text} → (skipped: ${res.reason})`);
    } else if (!res.ok) {
      log.info({ question: q.text, kind: q.kind, options: q.options, reason: res.reason }, 'cannot answer; skipping job');
      await closeDrawer(page, drawer);
      return { status: 'skipped-question', reason: res.reason, question: q.text };
    } else {
      log.info({ question: q.text, kind: q.kind, answer: res.answer, source: res.source }, 'answering');
      await submitAnswer(drawer, q, res.answer);
      answered.push(`${q.text} → ${res.answer} (${res.source})`);
    }
    previous = text;
    deadline = Date.now() + timeoutMs * 6;
    } catch (err) {
      // After the last answer Naukri may navigate away (seen live: that application had gone
      // through). Let the page settle; the success check at the top of the loop decides.
      if (!/execution context was destroyed|navigat|target closed|frame was detached/i.test(String(err))) throw err;
      log.info('page navigated during the chat; checking the result');
      await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
    }
  }
  return { status: 'failed', reason: 'no confirmation that the application went through' };
}
