import type { Locator, Page } from 'playwright';

/*
 * EVERY selector the automation uses lives in this file.
 *
 * Naukri changes its markup from time to time. When a run fails at a step, open the
 * screenshot/trace in /var/lib/naukri-refresher/artifacts/, then rediscover the element
 * on a desktop with:
 *
 *     npx playwright codegen https://www.naukri.com
 *
 * Prefer getByRole / getByLabel / getByPlaceholder / getByText. CSS ids (#attachCV, ...)
 * are kept only as `.or()` fallbacks. The local mock site (tests/mock-site) mirrors these
 * selectors; if you change one here, update the mock pages too so the flow tests stay true.
 */

/** URL paths, relative to config.baseUrl. */
export const paths = {
  login: '/nlogin/login',
  profile: '/mnjuser/profile',
} as const;

export const login = {
  username: (p: Page): Locator =>
    p.getByPlaceholder(/email id\s*\/\s*username/i).or(p.locator('#usernameField')),
  password: (p: Page): Locator =>
    p.getByPlaceholder(/enter (your )?password/i).or(p.locator('#passwordField')),
  submit: (p: Page): Locator => p.getByRole('button', { name: /^\s*login\s*$/i }),
  /** Inline error after submitting (wrong password, unknown user, ...). */
  error: (p: Page): Locator =>
    p.locator('.server-err, .erLbl, .err-container, [role="alert"]').filter({ hasText: /\S/ }),
};

/**
 * Anything that means "a human has to do this". We detect it and stop (exit 2);
 * we never try to solve or bypass it. The invisible reCAPTCHA v3 badge is excluded
 * because it sits on ordinary pages and is not a challenge.
 */
export const challenge = {
  otp: (p: Page): Locator =>
    p
      .getByText(/enter (the )?otp|one[- ]time password|otp (has been |was )?sent/i)
      .or(p.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]')),
  captcha: (p: Page): Locator =>
    p
      .locator(
        [
          'iframe[src*="recaptcha"][src*="bframe"]',
          'iframe[title="reCAPTCHA"]:not(.grecaptcha-badge iframe)',
          'iframe[src*="hcaptcha"]',
          'iframe[src*="captcha" i]:not([src*="recaptcha"])',
          '[id*="captcha" i]:not(.grecaptcha-badge):not(.grecaptcha-badge *)',
          '[class*="captcha" i]:not(.grecaptcha-badge):not(.grecaptcha-badge *)',
        ].join(', '),
      )
      .or(p.getByText(/verify (that )?you are (a )?human|i'?m not a robot|security check/i)),
};

/** Edit (pencil) control in a profile section header such as "Resume headline". */
function sectionEdit(p: Page, title: RegExp): Locator {
  return p
    .locator('.widgetHead')
    .filter({ hasText: title })
    .locator('.edit, [aria-label*="edit" i]');
}

export const profile = {
  /** Present only on the logged-in profile page; used as the "logged in" check. */
  marker: (p: Page): Locator => p.getByText(/^\s*resume headline\s*$/i),
  resumeInput: (p: Page): Locator =>
    p.locator('input[type="file"]#attachCV').or(p.locator('input[type="file"]')),
  uploadSuccess: (p: Page): Locator => p.getByText(/resume has been successfully uploaded|successfully uploaded/i),
  fileName: (p: Page, name: string): Locator => p.getByText(name),
  lastUpdatedToday: (p: Page): Locator => p.getByText(/last updated\s*[-–:]?\s*today/i),

  headlineEdit: (p: Page): Locator => sectionEdit(p, /resume headline/i),
  headlineInput: (p: Page): Locator =>
    p.locator('#resumeHeadlineTxt').or(p.getByRole('dialog').getByRole('textbox')),

  summaryEdit: (p: Page): Locator => sectionEdit(p, /profile summary/i),
  summaryInput: (p: Page): Locator =>
    p.locator('#profileSummaryTxt').or(p.getByRole('dialog').getByRole('textbox')),

  saveButton: (p: Page): Locator => p.getByRole('button', { name: /^\s*save\s*$/i }),
};

/** First *visible* match; avoids strict-mode errors from hidden duplicates. */
export function visible(locator: Locator): Locator {
  return locator.filter({ visible: true }).first();
}
