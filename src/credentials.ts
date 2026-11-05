import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Credentials come only from files in $CREDENTIALS_DIRECTORY:
 *  - native mode: systemd decrypts LoadCredentialEncrypted= files into a private ramfs.
 *  - Docker mode: scripts/docker-run.sh mounts a copy of that directory read-only.
 * Never from env vars, .env files, CLI args or the config file.
 */
export const CredentialName = {
  username: 'naukri-username',
  password: 'naukri-password',
  telegramBotToken: 'telegram-bot-token',
  ntfyToken: 'ntfy-token',
} as const;

export interface NaukriCredentials {
  username: string;
  password: string;
}

export async function readCredential(name: string): Promise<string | undefined> {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    const value = (await readFile(join(dir, name), 'utf8')).replace(/\r?\n$/, '');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function loadNaukriCredentials(): Promise<NaukriCredentials | undefined> {
  const [username, password] = await Promise.all([
    readCredential(CredentialName.username),
    readCredential(CredentialName.password),
  ]);
  return username && password ? { username, password } : undefined;
}
