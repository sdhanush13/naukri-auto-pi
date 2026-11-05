/**
 * Runs the real flow (src/naukri.ts + src/session.ts + src/selectors.ts) in headless Chromium
 * against the local mock site. Nothing here touches naukri.com.
 */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactsRoot } from '../../src/artifacts.js';
import { type Config, parseConfig } from '../../src/config.js';
import { runRefresh } from '../../src/naukri.js';
import { silentLog, tempDir, writeFakePdf } from '../helpers.js';
import { MOCK_PASSWORD, MOCK_USER, type MockSite, startMockSite } from '../mock-site/server.js';

let site: MockSite;
let dir: string;
let cleanup: () => Promise<void>;
let cfg: Config;
const credsDir = () => join(dir, 'creds');

const HEADLINE = 'Senior engineer - TypeScript, Playwright, Raspberry Pi automation';
const SUMMARY = 'Engineer who builds small, reliable automation. This summary is long enough to pass validation.';

async function setCreds(username = MOCK_USER, password = MOCK_PASSWORD): Promise<void> {
  await mkdir(credsDir(), { recursive: true });
  await writeFile(join(credsDir(), 'naukri-username'), username);
  await writeFile(join(credsDir(), 'naukri-password'), password);
}

const run = (dryRun = false) =>
  runRefresh(cfg, { dryRun, log: silentLog, chromiumSandbox: process.platform !== 'linux' });

const artifactRuns = async () => readdir(artifactsRoot(dir)).catch(() => [] as string[]);

beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => site.close());

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  site.reset();
  const resumePath = join(dir, 'My_Resume.pdf');
  await writeFakePdf(resumePath);
  cfg = parseConfig({
    resumePath,
    headline: HEADLINE,
    summary: SUMMARY,
    stateDir: dir,
    baseUrl: site.baseUrl,
    timeouts: { navigationMs: 10_000, actionMs: 5_000, uploadMs: 5_000 },
  });
  process.env.CREDENTIALS_DIRECTORY = credsDir();
  await setCreds();
});
afterEach(async () => {
  delete process.env.CREDENTIALS_DIRECTORY;
  await cleanup();
});

describe('flow against mock Naukri', () => {
  it('logs in, uploads, edits headline + summary, verifies, saves session', async () => {
    const result = await run();
    expect(result, result.message).toMatchObject({ code: 0 });
    expect(result.message).toMatch(/resume uploaded \(My_Resume\.pdf\), headline updated, summary updated/);
    expect(site.state.logins).toBe(1);
    expect(site.state.uploads).toEqual([{ name: 'My_Resume.pdf', size: 1024 }]);
    expect(site.state.headline).toBe(HEADLINE);
    expect(site.state.summary).toBe(SUMMARY);

    const statePath = join(dir, 'state.json');
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as { cookies: { name: string }[] };
    expect(saved.cookies.map((c) => c.name)).toContain('nauk_mock_session');
    if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(await artifactRuns()).toEqual([]); // no failure artifacts on success
  });

  it('reuses the saved session on the next run (no second login)', async () => {
    expect((await run()).code).toBe(0);
    site.state.updatedToday = false;
    expect((await run()).code).toBe(0);
    expect(site.state.logins).toBe(1);
    expect(site.state.uploads).toHaveLength(2);
  });

  it('works with no headline/summary configured (upload only)', async () => {
    cfg = { ...cfg, headline: undefined, summary: undefined };
    const result = await run();
    expect(result.code).toBe(0);
    expect(site.state.headline).toBe('Old headline');
  });

  it('stops with exit code 2 on an OTP page, with a screenshot and no upload', async () => {
    site.reset('otp');
    const result = await run();
    expect(result).toMatchObject({ code: 2 });
    expect(site.state.uploads).toEqual([]);
    const runs = await artifactRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/manual-login$/);
    expect(await readdir(join(artifactsRoot(dir), runs[0]!))).toContain('screenshot.png');
  });

  it('stops with exit code 2 on a CAPTCHA (and ignores the invisible reCAPTCHA badge otherwise)', async () => {
    site.reset('captcha');
    const result = await run();
    expect(result).toMatchObject({ code: 2 });
    expect(result.message).toMatch(/CAPTCHA/);
  });

  it('exits 2 (not 1, so no retry) when Naukri rejects the password', async () => {
    site.reset('badcreds');
    const result = await run();
    expect(result).toMatchObject({ code: 2 });
    expect(result.message).toMatch(/rejected/);
  });

  it('exits 2 when there is neither a session nor credentials', async () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    const result = await run();
    expect(result).toMatchObject({ code: 2 });
    expect(result.message).toMatch(/no Naukri credentials/);
  });

  it('fails with exit code 1 at step "upload" and keeps screenshot + trace', async () => {
    site.reset('uploadfail');
    const result = await run();
    expect(result).toMatchObject({ code: 1, step: 'upload' });
    const runs = await artifactRuns();
    expect(runs).toHaveLength(1);
    const files = await readdir(join(artifactsRoot(dir), runs[0]!));
    expect(files).toEqual(expect.arrayContaining(['screenshot.png', 'trace.zip']));
    // Tracing starts after login, so the password never ends up in the trace.
    const trace = await readFile(join(artifactsRoot(dir), runs[0]!, 'trace.zip'));
    expect(trace.includes(Buffer.from(MOCK_PASSWORD))).toBe(false);
  });

  it('dry run: logs in, screenshots the profile, changes nothing', async () => {
    const result = await run(true);
    expect(result).toMatchObject({ code: 0 });
    expect(result.message).toMatch(/Dry run OK/);
    expect(site.state.uploads).toEqual([]);
    expect(site.state.headline).toBe('Old headline');
    const runs = await artifactRuns();
    expect(runs[0]).toMatch(/dry-run$/);
    expect(await readdir(join(artifactsRoot(dir), runs[0]!))).toEqual(['profile.png']);
  });
});
