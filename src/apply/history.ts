import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate } from '../dailyCap.js';

export type JobStatus =
  | 'applied'
  | 'would-apply' // dry run
  | 'skipped-question' // a question we had no answer for
  | 'external' // "Apply on company site": never followed
  | 'already-applied'
  | 'filtered'
  | 'failed';

export interface JobRecord {
  status: JobStatus;
  title: string;
  company: string;
  url: string;
  at: string;
  reason?: string;
  /** For skipped-question: answers.json hash at the time; a changed file makes the job eligible again. */
  answersHash?: string;
}

export interface History {
  jobs: Record<string, JobRecord>;
  daily: { date: string; applied: number };
}

const FILE = 'apply-history.json';
const KEEP_DAYS = 60;

export async function loadHistory(stateDir: string, now = new Date()): Promise<History> {
  let h: History;
  try {
    h = JSON.parse(await readFile(join(stateDir, FILE), 'utf8')) as History;
  } catch {
    h = { jobs: {}, daily: { date: localDate(now), applied: 0 } };
  }
  if (h.daily?.date !== localDate(now)) h.daily = { date: localDate(now), applied: 0 };
  // Forget old entries so the file stays small; old postings won't show up in a 1-30 day search.
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  for (const [id, r] of Object.entries(h.jobs ?? {})) if (Date.parse(r.at) < cutoff) delete h.jobs[id];
  h.jobs ??= {};
  return h;
}

export async function saveHistory(stateDir: string, h: History): Promise<void> {
  const p = join(stateDir, FILE);
  await writeFile(`${p}.tmp`, JSON.stringify(h, null, 2), { mode: 0o600 });
  await rename(`${p}.tmp`, p);
}

/** Whether a job should be (re)considered this run. */
export function isEligible(h: History, jobId: string, answersHash: string): boolean {
  const r = h.jobs[jobId];
  if (!r) return true;
  if (r.status === 'would-apply' || r.status === 'failed') return true; // dry runs and errors retry
  if (r.status === 'skipped-question') return r.answersHash !== answersHash; // retry after you add answers
  return false;
}
