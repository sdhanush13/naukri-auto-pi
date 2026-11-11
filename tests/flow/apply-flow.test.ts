/**
 * Runs the real apply flow (src/apply/*) in headless Chromium against the local mock site,
 * including a fake Ollama endpoint. Nothing here touches naukri.com.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectiveMode, runApply } from '../../src/apply/run.js';
import { type Config, parseConfig } from '../../src/config.js';
import { silentLog, tempDir } from '../helpers.js';
import { MOCK_PASSWORD, MOCK_USER, type MockSite, startMockSite } from '../mock-site/server.js';

let site: MockSite;
let dir: string;
let cleanup: () => Promise<void>;
let cfg: Config;

const ANSWERS = {
  profile: 'Senior Software Engineer with 5 years of C#, .NET and Azure in Bengaluru. MCA degree. Uses Azure only.',
  rules: [
    { match: ['notice period'], answer: '60 days' },
    { match: ['relocate'], answer: 'Yes' },
  ],
  skills: { 'C#': 5, '.NET': 5 },
};

function makeConfig(apply: Record<string, unknown> = {}): Config {
  return parseConfig({
    resumePath: join(dir, 'r.pdf'),
    stateDir: dir,
    baseUrl: site.baseUrl,
    timeouts: { navigationMs: 10_000, actionMs: 5_000, uploadMs: 5_000 },
    apply: {
      mode: 'auto',
      searches: [
        { keywords: 'senior .net developer', location: 'bangalore' },
        { keywords: '.net azure', remote: true },
      ],
      experienceYears: 5,
      requireTitleWords: ['.net', 'dotnet'],
      answersPath: join(dir, 'answers.json'),
      llm: { url: site.baseUrl, model: 'fake' },
      pauseSeconds: 2,
      ...apply,
    },
  });
}

const run = (dryRun = false) => runApply(cfg, { dryRun, log: silentLog, chromiumSandbox: process.platform !== 'linux' });
const history = async () => JSON.parse(await readFile(join(dir, 'apply-history.json'), 'utf8'));

beforeAll(async () => {
  site = await startMockSite();
});
afterAll(() => site.close());
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  site.reset();
  await writeFile(join(dir, 'answers.json'), JSON.stringify(ANSWERS));
  const creds = join(dir, 'creds');
  await mkdir(creds, { recursive: true });
  await writeFile(join(creds, 'naukri-username'), MOCK_USER);
  await writeFile(join(creds, 'naukri-password'), MOCK_PASSWORD);
  process.env.CREDENTIALS_DIRECTORY = creds;
  cfg = makeConfig();
});
afterEach(async () => {
  delete process.env.CREDENTIALS_DIRECTORY;
  await cleanup();
});

describe('apply flow against mock Naukri', () => {
  it('applies, answers the chatbot, skips what it cannot answer, never follows company sites', async () => {
    const r = await run();
    expect(r, r.message).toMatchObject({ code: 0 });
    expect(site.state.searches).toHaveLength(2);
    expect(site.state.searches[0]).toMatch(/^\/senior-dot-net-developer-jobs-in-bangalore\?k=senior%20\.net%20developer&l=bangalore&experience=5&jobAge=3$/);
    expect(site.state.searches[1]).toMatch(/wfhType=2/);

    expect(site.state.applications.map((a) => a.id)).toEqual(['100', '101']);
    expect(site.state.applications[1]!.answers).toEqual([
      { q: 'What is your notice period?', a: '60 days' },
      { q: 'Are you willing to relocate?', a: 'Yes' },
      { q: 'How many years of experience do you have in C#?', a: '5' },
      { q: 'Which clouds have you used?', a: 'Azure' }, // from the (fake) local model
    ]);
    expect(site.state.llmCalls).toBe(1); // the CTC question never reached the model

    const h = await history();
    expect(h.jobs['102'].status).toBe('filtered'); // Java title
    expect(h.jobs['103'].status).toBe('external');
    expect(h.jobs['104'].status).toBe('already-applied');
    expect(h.jobs['105']).toMatchObject({ status: 'skipped-question' });
    expect(h.jobs['106'].status).toBe('filtered'); // 10-15 yrs
    expect(h.daily.applied).toBe(2);
    expect(r.message).toMatch(/Applied to 2/);
    expect(r.message).toMatch(/What is your current CTC\?/);
  });

  it('does not apply twice, and retries a skipped job only after answers.json changes', async () => {
    await run();
    const second = await run();
    expect(second.code).toBe(0);
    expect(site.state.applications).toHaveLength(2);

    await writeFile(join(dir, 'answers.json'), JSON.stringify({ ...ANSWERS, rules: [...ANSWERS.rules, { match: ['current ctc'], answer: '20 LPA' }] }));
    await run();
    expect(site.state.applications.map((a) => a.id)).toEqual(['100', '101', '105']);
  });

  it('dry run lists jobs and applies to nothing', async () => {
    const r = await run(true);
    expect(r.code).toBe(0);
    expect(site.state.applications).toEqual([]);
    expect(r.message).toMatch(/DRY RUN: would apply to 3/);
    expect(r.message).toMatch(/Senior \.NET Developer @ Acme/);
  });

  it('stops at the daily limit and at Naukri\'s quota message', async () => {
    cfg = makeConfig({ maxPerDay: 1 });
    await run();
    expect(site.state.applications).toHaveLength(1);
    expect((await run()).message).toMatch(/Daily limit of 1/);

    site.reset();
    await writeFile(join(dir, 'apply-history.json'), '{}');
    site.state.quota = 1;
    cfg = makeConfig();
    const r = await run();
    expect(site.state.applications).toHaveLength(1);
    expect(r.message).toMatch(/quota/);
  });

  it('treats "auto" as dry run before autoFrom', () => {
    const a = makeConfig({ autoFrom: '2026-11-18' }).apply!;
    expect(effectiveMode(a, new Date(2026, 10, 17), false)).toBe('dry-run');
    expect(effectiveMode(a, new Date(2026, 10, 18), false)).toBe('auto');
    expect(effectiveMode(a, new Date(2026, 10, 18), true)).toBe('dry-run');
  });
});
