import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

/** A run never legitimately takes longer than this (systemd TimeoutStartSec is 25 min). */
export const STALE_LOCK_MS = 30 * 60 * 1000;

function isAlive(pid: number): boolean {
  if (pid === process.pid) return false; // left over from a previous container that reused our PID
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(info: LockInfo | undefined, now: number, staleMs: number): boolean {
  if (!info) return true;
  const age = now - Date.parse(info.startedAt);
  if (!Number.isFinite(age) || age > staleMs) return true;
  return info.host === hostname() && !isAlive(info.pid);
}

function readLock(path: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * Exclusive-create lock file. Returns a release function.
 * systemd already refuses to start a second copy of the service; this also covers
 * manual `npm start` runs and overlapping Docker containers.
 */
export function acquireLock(path: string, opts: { staleMs?: number; now?: number } = {}): () => void {
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date(opts.now ?? Date.now()).toISOString() };
  const body = JSON.stringify(info);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, body);
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(path, 'utf8') === body) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readLock(path);
      if (attempt === 0 && isStale(existing, opts.now ?? Date.now(), staleMs)) {
        try {
          unlinkSync(path);
        } catch {
          /* raced with someone else; the second attempt decides */
        }
        continue;
      }
      throw new LockHeldError(
        `Another run holds ${path} (pid ${existing?.pid ?? '?'} on ${existing?.host ?? '?'} since ${existing?.startedAt ?? '?'})`,
      );
    }
  }
  throw new LockHeldError(`Could not acquire ${path}`);
}
