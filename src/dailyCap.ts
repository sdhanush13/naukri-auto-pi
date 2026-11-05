import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ATTEMPTS_PER_DAY } from './exitCodes.js';

interface AttemptLog {
  date: string;
  count: number;
}

/** Local calendar date (the Pi / container runs with TZ=Asia/Kolkata). */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Records one real attempt for today, or returns false if the daily cap is already used up.
 * This makes "never more than 2 attempts per day" hold even across the timer, a catch-up
 * run after a power cut (Persistent=true) and manual scripts/run-now.sh calls.
 */
export async function claimDailyAttempt(
  stateDir: string,
  now: Date = new Date(),
  max: number = MAX_ATTEMPTS_PER_DAY,
): Promise<boolean> {
  const path = join(stateDir, 'attempts.json');
  const today = localDate(now);
  let log: AttemptLog = { date: today, count: 0 };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AttemptLog;
    if (parsed.date === today && Number.isInteger(parsed.count)) log = parsed;
  } catch {
    /* first run or unreadable: start fresh */
  }
  if (log.count >= max) return false;
  log.count += 1;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(log), { mode: 0o600 });
  await rename(tmp, path);
  return true;
}
