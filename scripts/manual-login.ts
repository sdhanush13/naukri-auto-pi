/**
 * Recovery path for exit code 2. Run this on your laptop/desktop, NOT on the Pi:
 *
 *     npm ci && npx playwright install chromium
 *     npm run manual-login                     # writes ./state.json
 *     npm run manual-login -- --out other.json
 *
 * A normal (headed) Chromium window opens on the Naukri login page. YOU log in and complete
 * any OTP / CAPTCHA yourself. The script notices when Naukri lands on your logged-in pages
 * (or, with --enter, waits for you to press Enter), checks the profile page and saves the
 * session (cookies + local storage) to state.json for the Pi.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import * as sel from '../src/selectors.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'state.json' },
    'base-url': { type: 'string', default: 'https://www.naukri.com' },
    /** Wait for Enter instead of detecting the login automatically. */
    enter: { type: 'boolean', default: false },
  },
});
const out = resolve(values.out!);
const baseUrl = values['base-url']!;

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(new URL(sel.paths.login, baseUrl).toString());

  console.log('\nA browser window is open on the Naukri login page.');
  console.log('Log in yourself and complete any OTP or verification (you have 10 minutes).');
  if (values.enter) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('When you can see your Naukri home page, press Enter here... ');
    rl.close();
  } else {
    // After a successful login Naukri moves to /mnjuser/... (home page). Detect that ourselves.
    await page.waitForURL((u) => u.pathname.startsWith('/mnjuser/'), { timeout: 10 * 60_000 });
    console.log('Login detected.');
  }

  await page.goto(new URL(sel.paths.profile, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  try {
    await sel.visible(sel.profile.marker(page)).waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    throw new Error(
      'The profile page does not look logged in (no "Resume headline" section). Nothing saved.\n' +
        'If you are logged in, the selector in src/selectors.ts (profile.marker) may need updating.',
    );
  }

  const state = await context.storageState();
  await writeFile(out, JSON.stringify(state), { mode: 0o600 });
  await chmod(out, 0o600).catch(() => undefined);
  console.log(`\nSaved session to ${out}`);
  console.log('Copy it to the Pi (replace pi@raspberrypi.local with your Pi):\n');
  console.log(`  scp "${out}" pi@raspberrypi.local:/tmp/naukri-state.json`);
  console.log(
    '  ssh pi@raspberrypi.local "sudo install -m 600 -o naukri -g naukri /tmp/naukri-state.json /var/lib/naukri-refresher/state.json && rm /tmp/naukri-state.json"',
  );
  console.log('\nThen delete the local copy; it is as sensitive as your password.');
} finally {
  await browser.close();
}
