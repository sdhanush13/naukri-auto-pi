import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

export const silentLog = pino({ level: 'silent' });

export async function tempDir(prefix = 'naukri-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Minimal valid-looking PDF (correct magic bytes). */
export async function writeFakePdf(path: string, bytes = 1024): Promise<void> {
  const header = Buffer.from('%PDF-1.4\n');
  await writeFile(path, Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - header.length), 0x20)]));
}
