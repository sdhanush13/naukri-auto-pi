import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const KEEP_ARTIFACT_RUNS = 10;

export function artifactsRoot(stateDir: string): string {
  return join(stateDir, 'artifacts');
}

/**
 * One folder per run: artifacts/2026-11-05T04-30-00-123Z-upload/{screenshot.png,trace.zip}.
 * ISO-ish names sort chronologically, which is what pruning relies on.
 */
export async function newRunDir(stateDir: string, label: string, now: Date = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const dir = join(artifactsRoot(stateDir), `${stamp}-${safeLabel}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Keep only the newest `keep` run folders. Traces can contain session cookies, so old ones go. */
export async function pruneArtifacts(stateDir: string, keep: number = KEEP_ARTIFACT_RUNS): Promise<string[]> {
  const root = artifactsRoot(stateDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  const doomed = runs.slice(keep);
  await Promise.all(doomed.map((name) => rm(join(root, name), { recursive: true, force: true })));
  return doomed;
}
