import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkResumeFile, ConfigError, loadConfig, MAX_RESUME_BYTES, parseConfig } from '../../src/config.js';
import { tempDir, writeFakePdf } from '../helpers.js';

const base = { resumePath: '/etc/naukri-refresher/resume/resume.pdf' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const cfg = parseConfig(base);
    expect(cfg.schedule).toBe('Mon..Fri 10:00');
    expect(cfg.stateDir).toBe('/var/lib/naukri-refresher');
    expect(cfg.baseUrl).toBe('https://www.naukri.com');
    expect(cfg.notify).toEqual({ provider: 'none' });
    expect(cfg.timeouts).toEqual({ navigationMs: 45_000, actionMs: 20_000, uploadMs: 90_000 });
    expect(cfg.retryDelaySeconds).toBe(60);
    expect(cfg.browserMode).toBe('headless'); // headed is an explicit opt-in
  });

  it('accepts only the two browser modes', () => {
    expect(parseConfig({ ...base, browserMode: 'headed' }).browserMode).toBe('headed');
    expect(() => parseConfig({ ...base, browserMode: 'stealth' })).toThrow(ConfigError);
  });

  // "one two three four " padded to an exact length, so the 5-word rule is met.
  const words = (len: number): string => `one two three four ${'x'.repeat(len - 19)}`;

  it('accepts a headline of exactly 250 chars and rejects 251', () => {
    expect(parseConfig({ ...base, headline: words(250) }).headline).toHaveLength(250);
    expect(() => parseConfig({ ...base, headline: words(251) })).toThrow(/at most 250/);
  });

  it('measures the headline after trimming', () => {
    expect(parseConfig({ ...base, headline: `  ${words(250)}  ` }).headline).toHaveLength(250);
  });

  it('requires at least 5 words in the headline (Naukri rule)', () => {
    expect(() => parseConfig({ ...base, headline: 'Senior TypeScript engineer, Bengaluru' })).toThrow(/5 words/);
    expect(parseConfig({ ...base, headline: 'Senior TypeScript engineer in Bengaluru' }).headline).toBeTruthy();
  });

  it('requires a summary of 50-1000 chars', () => {
    expect(() => parseConfig({ ...base, summary: 'x'.repeat(49) })).toThrow(/at least 50/);
    expect(parseConfig({ ...base, summary: 'x'.repeat(50) }).summary).toHaveLength(50);
    expect(parseConfig({ ...base, summary: 'x'.repeat(1000) }).summary).toHaveLength(1000);
    expect(() => parseConfig({ ...base, summary: 'x'.repeat(1001) })).toThrow(/at most 1000/);
  });

  it('only accepts pdf/doc/docx resume paths', () => {
    for (const ok of ['a.pdf', 'a.DOC', 'a.docx']) expect(() => parseConfig({ resumePath: ok })).not.toThrow();
    for (const bad of ['a.txt', 'a.pdf.exe', 'resume']) expect(() => parseConfig({ resumePath: bad })).toThrow(ConfigError);
  });

  it('rejects unknown keys (catches typos like "headlin")', () => {
    expect(() => parseConfig({ ...base, headlin: 'x' })).toThrow(ConfigError);
  });

  it('validates notifier settings', () => {
    expect(parseConfig({ ...base, notify: { provider: 'ntfy', topic: 'my-topic_1' } }).notify).toEqual({
      provider: 'ntfy',
      server: 'https://ntfy.sh',
      topic: 'my-topic_1',
    });
    expect(() => parseConfig({ ...base, notify: { provider: 'ntfy' } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, notify: { provider: 'ntfy', topic: 'has space' } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, notify: { provider: 'telegram', chatId: '-100123' } })).not.toThrow();
    expect(() => parseConfig({ ...base, notify: { provider: 'telegram', chatId: 'abc' } })).toThrow(ConfigError);
    // Secrets never belong in the config file.
    expect(() => parseConfig({ ...base, notify: { provider: 'telegram', chatId: '1', token: 'x' } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, password: 'x' })).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('reports a missing file and invalid JSON clearly', async () => {
    await expect(loadConfig(join(dir, 'nope.json'))).rejects.toThrow(/Cannot read config/);
    await writeFile(join(dir, 'bad.json'), '{ not json');
    await expect(loadConfig(join(dir, 'bad.json'))).rejects.toThrow(/not valid JSON/);
  });

  it('loads a valid file', async () => {
    await writeFile(join(dir, 'c.json'), JSON.stringify(base));
    expect((await loadConfig(join(dir, 'c.json'))).resumePath).toBe(base.resumePath);
  });
});

describe('checkResumeFile', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('accepts a real PDF up to 2 MB', async () => {
    const p = join(dir, 'resume.pdf');
    await writeFakePdf(p, MAX_RESUME_BYTES);
    await expect(checkResumeFile(p)).resolves.toEqual({ sizeBytes: MAX_RESUME_BYTES });
  });

  it('rejects files over 2 MB', async () => {
    const p = join(dir, 'resume.pdf');
    await writeFakePdf(p, MAX_RESUME_BYTES + 1);
    await expect(checkResumeFile(p)).rejects.toThrow(/at most 2 MB/);
  });

  it('rejects missing, empty, wrong-type and disguised files', async () => {
    await expect(checkResumeFile(join(dir, 'missing.pdf'))).rejects.toThrow(/not found/);
    await writeFile(join(dir, 'empty.pdf'), '');
    await expect(checkResumeFile(join(dir, 'empty.pdf'))).rejects.toThrow(/empty/);
    await writeFile(join(dir, 'notes.txt'), 'hello');
    await expect(checkResumeFile(join(dir, 'notes.txt'))).rejects.toThrow(/\.pdf, \.doc or \.docx/);
    await writeFile(join(dir, 'fake.pdf'), 'just text pretending');
    await expect(checkResumeFile(join(dir, 'fake.pdf'))).rejects.toThrow(/does not look like/);
  });

  it('accepts a docx (zip signature)', async () => {
    const p = join(dir, 'resume.docx');
    await writeFile(p, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    await expect(checkResumeFile(p)).resolves.toBeTruthy();
  });
});
