/**
 * Read-only helper (laptop): prints your current resume headline and profile summary so you
 * can copy them into config.json. Uses a saved session (state.json from manual-login).
 * It opens each editor to read the exact text, then closes it with Cancel/Escape. It never
 * clicks Save or Delete, and it does not write the session back.
 *
 *     npx tsx scripts/read-profile-text.ts [--state state.json] [--out profile-text.json]
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, type Locator, type Page } from 'playwright';
import * as sel from '../src/selectors.js';

const { values } = parseArgs({
  options: {
    state: { type: 'string', default: 'state.json' },
    out: { type: 'string', default: 'profile-text.json' },
    'base-url': { type: 'string', default: 'https://www.naukri.com' },
  },
});

async function readEditor(page: Page, sectionId: string, edit: Locator, input: Locator): Promise<string | null> {
  try {
    await page.locator(`#${sectionId}`).scrollIntoViewIfNeeded(); // lazy-loaded sections
    await sel.visible(edit).click({ timeout: 15_000 });
    const box = sel.visible(input);
    await box.waitFor({ state: 'visible', timeout: 15_000 });
    return (await box.inputValue()).trim();
  } catch (e) {
    console.error(`[${sectionId}] could not read: ${(e as Error).message.split('\n')[0]}`);
    return null;
  } finally {
    const cancel = page.getByRole('button', { name: /^\s*cancel\s*$/i }).or(page.getByText(/^\s*cancel\s*$/i));
    if (await cancel.filter({ visible: true }).count()) await sel.visible(cancel).click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
}

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({ storageState: values.state, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(new URL(sel.paths.profile, values['base-url']).toString(), { waitUntil: 'domcontentloaded' });
  await sel.visible(sel.profile.marker(page)).waitFor({ state: 'visible', timeout: 45_000 });

  const headline = await readEditor(page, 'lazyResumeHead', sel.profile.headlineEdit(page), sel.profile.headlineInput(page));
  // A still-open editor locks scrolling; start the summary from a fresh page.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sel.visible(sel.profile.marker(page)).waitFor({ state: 'visible', timeout: 45_000 });
  const summary = await readEditor(page, 'lazyProfileSummary', sel.profile.summaryEdit(page), sel.profile.summaryInput(page));
  const section = async (css: string) =>
    (await page.locator(css).first().innerText().catch(() => '')).trim() || null;

  const json = JSON.stringify(
    {
      headline,
      summary,
      // Fallback: raw section text, in case an editor could not be opened.
      headlineSection: headline ? undefined : await section('#lazyResumeHead'),
      summarySection: summary ? undefined : await section('#lazyProfileSummary'),
    },
    null,
    2,
  );
  await writeFile(values.out!, `${json}\n`, 'utf8');
  console.log(json);
  console.log(`\nAlso written (UTF-8) to ${values.out}`);
} finally {
  await browser.close();
}
