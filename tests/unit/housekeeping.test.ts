import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactsRoot, newRunDir, pruneArtifacts } from '../../src/artifacts.js';
import { claimDailyAttempt, localDate } from '../../src/dailyCap.js';
import { acquireLock, LockHeldError } from '../../src/lock.js';
import { tempDir } from '../helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

describe('artifacts', () => {
  it('keeps only the newest 10 runs', async () => {
    const start = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 13; i++) await newRunDir(dir, `run${i}`, new Date(start + i * 60_000));
    const removed = await pruneArtifacts(dir);
    expect(removed).toHaveLength(3);
    const left = (await readdir(artifactsRoot(dir))).sort();
    expect(left).toHaveLength(10);
    expect(left[0]).toMatch(/run3$/);
    expect(left[9]).toMatch(/run12$/);
  });

  it('sanitises labels', async () => {
    const d = await newRunDir(dir, '../../etc/passwd');
    expect(d.startsWith(artifactsRoot(dir))).toBe(true);
  });
});

describe('daily cap', () => {
  it('allows two attempts per local day, then refuses until tomorrow', async () => {
    const day = new Date(2026, 10, 5, 10, 0);
    expect(await claimDailyAttempt(dir, day)).toBe(true);
    expect(await claimDailyAttempt(dir, day)).toBe(true);
    expect(await claimDailyAttempt(dir, day)).toBe(false);
    expect(await claimDailyAttempt(dir, new Date(2026, 10, 6, 10, 0))).toBe(true);
  });

  it('supports 3 runs a day with a cap of 4 (one spare for a retry)', async () => {
    const day = new Date(2026, 10, 5, 9, 0);
    for (let i = 0; i < 4; i++) expect(await claimDailyAttempt(dir, day, 4)).toBe(true);
    expect(await claimDailyAttempt(dir, day, 4)).toBe(false);
  });

  it('formats the local date', () => {
    expect(localDate(new Date(2026, 0, 9, 23, 59))).toBe('2026-01-09');
  });
});

describe('lock', () => {
  it('creates and releases the lock file', async () => {
    const p = join(dir, 'run.lock');
    const release = acquireLock(p);
    expect(await readdir(dir)).toContain('run.lock');
    release();
    expect(await readdir(dir)).not.toContain('run.lock');
  });

  it('respects a fresh lock held by another live process on this host', async () => {
    const p = join(dir, 'run.lock');
    // The test runner's parent process is alive and is not us.
    await writeFile(p, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date().toISOString() }));
    expect(() => acquireLock(p)).toThrow(LockHeldError);
  });

  it('takes over a lock older than the stale limit', async () => {
    const p = join(dir, 'run.lock');
    await writeFile(p, JSON.stringify({ pid: 999999, host: 'elsewhere', startedAt: '2020-01-01T00:00:00Z' }));
    expect(() => acquireLock(p)()).not.toThrow();
  });

  it('takes over a fresh lock from a dead process on this host', async () => {
    const p = join(dir, 'run.lock');
    await writeFile(p, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), startedAt: new Date().toISOString() }));
    expect(() => acquireLock(p)()).not.toThrow();
  });

  it('respects a fresh lock from another host', async () => {
    const p = join(dir, 'run.lock');
    await mkdir(dir, { recursive: true });
    await writeFile(p, JSON.stringify({ pid: 1, host: 'other-host', startedAt: new Date().toISOString() }));
    expect(() => acquireLock(p)).toThrow(LockHeldError);
  });
});
