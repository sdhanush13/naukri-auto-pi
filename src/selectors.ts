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
 *
 * Sources (Nov 2026), cross-checked across public Naukri automation repos, chiefly a
 * profile-editor write-up verified against the live site on 2026-10-31:
 *  - resume upload: hidden `#attachCV` file input; NO confirmation step - the resume card
 *    just changes to "Uploaded on Nov 05, 2026" (some repos also saw
 *    "Resume has been successfully uploaded.").
 *  - top card: "Profile last updated - 05Nov, 2026" (a date, not "Today").
 *  - headline: section `#lazyResumeHead`, edit `span.edit.icon` named "Edit resume headline",
 *    textarea `#resumeHeadlineTxt` (max 250, min 5 words), form `resumeHeadlineForm`.
 *  - summary: section `#lazyProfileSummary`, button "Edit profile summary", textarea
 *    `#profileSummaryTxt` in form `profileSummaryForm` (max 1000; verified live 2026-11-05),
 *    Save + Cancel (`a.cancel-btn`), and a "Delete" link we must never click.
 *  - sections below the fold are lazy-loaded: empty until scrolled into view
 *    (`data-loaded="true"` once rendered). Verified live 2026-11-05.
 *  - the first save of a session may open a Pro upsell modal "Profile updated successfully".
 *  - OTP page: "Enter OTP", `.otp-container`, `.otpField`.
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
  submit: (p: Page): Locator => p.getByRole('button', { name: /^\s*login\s*$/i }).or(p.locator('button.loginButton')),
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
      .or(
        p.locator(
          '.otp-container, [class*="otpField"], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]',
        ),
      ),
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Matches the given local date as Naukri prints it: "05Nov, 2026", "5 Nov 2026",
 * "Nov 05, 2026", "November 5, 2026" - or the word "Today".
 */
export function datePattern(now: Date): string {
  const mon = MONTHS[now.getMonth()];
  const d = now.getDate();
  const y = now.getFullYear();
  return `(?:today|\\b0?${d}\\s*${mon}[a-z]*,?\\s*${y}|\\b${mon}[a-z]*\\s+0?${d}\\b,?\\s*${y})`;
}

export function uploadedOnRegex(now: Date): RegExp {
  return new RegExp(`uploaded on\\s*:?\\s*${datePattern(now)}`, 'i');
}

export function lastUpdatedRegex(now: Date): RegExp {
  return new RegExp(`last updated\\s*[-–:]?\\s*${datePattern(now)}`, 'i');
}

export const profile = {
  /** Present only on the logged-in profile page; used as the "logged in" check. */
  marker: (p: Page): Locator => p.getByText(/^\s*resume headline\s*$/i).or(p.locator('#lazyResumeHead')),
  resumeInput: (p: Page): Locator =>
    p.locator('input[type="file"]#attachCV').or(p.locator('input[type="file"]')),
  /** Either an explicit message (seen by some) or the resume card showing today's date (current UI). */
  uploadDone: (p: Page, now: Date): Locator =>
    p.getByText(/resume has been successfully uploaded|uploaded successfully/i).or(p.getByText(uploadedOnRegex(now))),
  uploadedOn: (p: Page, now: Date): Locator => p.getByText(uploadedOnRegex(now)),
  lastUpdated: (p: Page, now: Date): Locator => p.getByText(lastUpdatedRegex(now)),
  fileName: (p: Page, name: string): Locator => p.getByText(name),

  headlineEdit: (p: Page): Locator =>
    p
      .getByRole('button', { name: /edit resume headline/i })
      .or(p.locator('#lazyResumeHead span.edit, .resumeHeadline span.edit')),
  headlineInput: (p: Page): Locator =>
    p.locator('#resumeHeadlineTxt').or(p.locator('form[name="resumeHeadlineForm"] textarea')),

  summaryEdit: (p: Page): Locator =>
    p
      .getByRole('button', { name: /edit profile summary/i })
      .or(p.locator('#lazyProfileSummary span.edit, .profileSummary span.edit')),
  /** The summary textarea's id is not documented anywhere; fall back to the open modal's textarea. */
  summaryInput: (p: Page): Locator =>
    p
      .locator('#profileSummaryTxt, form[name="profileSummaryForm"] textarea')
      .or(p.getByRole('dialog').locator('textarea'))
      .or(p.locator('textarea')),

  /** Exact name "Save", so the summary modal's "Delete" link can never match. */
  saveButton: (p: Page): Locator => p.getByRole('button', { name: /^\s*save\s*$/i }),
};

/** "Go Pro" upsell that can appear after the first save of a session; we just close it. */
export const upsell = {
  modal: (p: Page): Locator => p.getByText(/profile updated successfully/i),
  close: (p: Page): Locator =>
    p.getByRole('button', { name: /^\s*(close|×|x)\s*$/i }).or(p.locator('.crossIcon, [class*="close" i]')),
};

/** First *visible* match; avoids strict-mode errors from hidden duplicates. */
export function visible(locator: Locator): Locator {
  return locator.filter({ visible: true }).first();
}
