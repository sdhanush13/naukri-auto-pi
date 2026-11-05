import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { Config } from './config.js';
import { loadNaukriCredentials } from './credentials.js';
import { ManualLoginRequired, StepError } from './exitCodes.js';
import type { Logger } from './logger.js';
import * as sel from './selectors.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export function statePath(stateDir: string): string {
  return join(stateDir, 'state.json');
}

export async function loadStorageState(path: string): Promise<StorageState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as StorageState;
    return Array.isArray(parsed.cookies) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write, mode 600. state.json holds live session cookies: treat it like a password. */
export async function saveStorageState(context: BrowserContext, path: string): Promise<void> {
  const state = await context.storageState();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined); // no-op on Windows
}

export type PageState = 'logged-in' | 'login-form' | 'challenge:otp' | 'challenge:captcha';

export function url(cfg: Config, path: string): string {
  return new URL(path, cfg.baseUrl).toString();
}

/** Waits until the page shows one of the states we understand, then says which. */
export async function classifyPage(page: Page, timeoutMs: number): Promise<PageState> {
  const loggedIn = sel.profile.marker(page);
  const otp = sel.challenge.otp(page);
  const captcha = sel.challenge.captcha(page);
  const form = sel.login.username(page);
  try {
    await sel.visible(loggedIn.or(otp).or(captcha).or(form)).waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (err) {
    throw new StepError('session', `Page ${page.url()} showed neither the profile, a login form nor a verification step`, {
      cause: err,
    });
  }
  if (await sel.visible(loggedIn).isVisible()) return 'logged-in';
  if (await sel.visible(captcha).isVisible()) return 'challenge:captcha';
  if (await sel.visible(otp).isVisible()) return 'challenge:otp';
  return 'login-form';
}

function throwIfChallenge(state: PageState): void {
  if (state === 'challenge:otp') throw new ManualLoginRequired('Naukri asked for an OTP / verification code');
  if (state === 'challenge:captcha') throw new ManualLoginRequired('Naukri showed a CAPTCHA');
}

type LoginOutcome = 'navigated' | 'challenge' | 'error' | 'timeout';

async function waitForLoginOutcome(page: Page, timeoutMs: number): Promise<LoginOutcome> {
  const settle = <T>(p: Promise<T>, value: LoginOutcome): Promise<LoginOutcome> =>
    p.then(
      () => value,
      () => 'timeout' as const,
    );
  const loginPath = sel.paths.login;
  const outcomes = [
    settle(page.waitForURL((u) => !u.pathname.startsWith(loginPath), { timeout: timeoutMs }), 'navigated'),
    settle(
      sel.visible(sel.challenge.otp(page).or(sel.challenge.captcha(page))).waitFor({ state: 'visible', timeout: timeoutMs }),
      'challenge',
    ),
    settle(sel.visible(sel.login.error(page)).waitFor({ state: 'visible', timeout: timeoutMs }), 'error'),
  ];
  // First real outcome wins; 'timeout' only if every waiter timed out.
  return new Promise((resolve) => {
    let pending = outcomes.length;
    for (const o of outcomes) {
      void o.then((v) => {
        pending -= 1;
        if (v !== 'timeout') resolve(v);
        else if (pending === 0) resolve('timeout');
      });
    }
  });
}

/**
 * Reuse the saved session if it still works; otherwise log in with the stored credentials.
 * Any OTP / CAPTCHA / verification => ManualLoginRequired (exit 2). Never solved, never bypassed.
 */
export async function ensureLoggedIn(page: Page, cfg: Config, log: Logger): Promise<'session' | 'login'> {
  const nav = cfg.timeouts.navigationMs;
  await page.goto(url(cfg, sel.paths.profile), { waitUntil: 'domcontentloaded' });
  let state = await classifyPage(page, nav);
  if (state === 'logged-in') {
    log.info('saved session is valid');
    return 'session';
  }
  throwIfChallenge(state);

  const creds = await loadNaukriCredentials();
  if (!creds) {
    throw new ManualLoginRequired('session expired and no Naukri credentials are configured (scripts/set-credentials.sh)');
  }

  log.info('session missing or expired; logging in with stored credentials');
  if (!new URL(page.url()).pathname.startsWith(sel.paths.login)) {
    await page.goto(url(cfg, sel.paths.login), { waitUntil: 'domcontentloaded' });
    state = await classifyPage(page, nav);
    throwIfChallenge(state);
  }

  await sel.visible(sel.login.username(page)).fill(creds.username);
  await sel.visible(sel.login.password(page)).fill(creds.password);
  await sel.visible(sel.login.submit(page)).click();

  const outcome = await waitForLoginOutcome(page, nav);
  if (outcome === 'challenge') throw new ManualLoginRequired('Naukri asked for verification after login');
  if (outcome === 'error') {
    // Not retried: repeating a rejected password risks locking the account.
    throw new ManualLoginRequired('Naukri rejected the username/password; re-run scripts/set-credentials.sh');
  }
  if (outcome === 'timeout') throw new StepError('login', 'No response after submitting the login form');

  await page.goto(url(cfg, sel.paths.profile), { waitUntil: 'domcontentloaded' });
  state = await classifyPage(page, nav);
  if (state === 'logged-in') {
    log.info('logged in');
    return 'login';
  }
  throwIfChallenge(state);
  // Most likely an unrecognised verification step that redirected elsewhere. Exit 2 instead of
  // retrying, so we never trigger a second OTP or hammer the login form.
  throw new ManualLoginRequired(`still not logged in after submitting credentials (landed on ${page.url()})`);
}
