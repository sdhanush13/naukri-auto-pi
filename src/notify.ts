import type { Config } from './config.js';
import { CredentialName, readCredential } from './credentials.js';
import type { Logger } from './logger.js';

export type NotifyStatus = 'success' | 'failure' | 'manual' | 'dry-run';

export interface Notification {
  status: NotifyStatus;
  message: string;
}

const ICON: Record<NotifyStatus, string> = { success: '✅', failure: '❌', manual: '⚠️', 'dry-run': '🧪' };
const NTFY_TAGS: Record<NotifyStatus, string> = {
  success: 'white_check_mark',
  failure: 'x',
  manual: 'warning',
  'dry-run': 'test_tube',
};
const TITLE: Record<NotifyStatus, string> = {
  success: 'Naukri profile refreshed',
  failure: 'Naukri refresh failed',
  manual: 'Naukri: manual login needed',
  'dry-run': 'Naukri dry run',
};

const TIMEOUT_MS = 10_000;

export function formatNotification(n: Notification): { title: string; text: string } {
  return { title: TITLE[n.status], text: `${ICON[n.status]} ${n.message}` };
}

/** Sends the result. A notification failure is logged and never changes the exit code. */
export async function notify(cfg: Config, n: Notification, log: Logger): Promise<void> {
  const { title, text } = formatNotification(n);
  try {
    switch (cfg.notify.provider) {
      case 'none':
        return;
      case 'ntfy': {
        const headers: Record<string, string> = {
          Title: title,
          Tags: NTFY_TAGS[n.status],
          Priority: n.status === 'success' || n.status === 'dry-run' ? '3' : '4',
        };
        const token = await readCredential(CredentialName.ntfyToken);
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(new URL(cfg.notify.topic, ensureSlash(cfg.notify.server)), {
          method: 'POST',
          headers,
          body: text,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) log.warn({ status: res.status }, 'ntfy notification was not accepted');
        return;
      }
      case 'telegram': {
        const token = await readCredential(CredentialName.telegramBotToken);
        if (!token) {
          log.warn('telegram selected but the telegram-bot-token credential is missing');
          return;
        }
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.notify.chatId, text: `${title}\n${text}` }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) log.warn({ status: res.status }, 'telegram notification was not accepted');
        return;
      }
    }
  } catch (err) {
    // Deliberately log only the error name: a fetch error could otherwise echo the bot URL (with token).
    log.warn({ error: (err as Error).name }, 'notification failed');
  }
}

export type HealthcheckKind = 'start' | 'success' | 'fail';

/** Optional healthchecks.io dead-man's switch. If the Pi dies, the missing ping alerts you. */
export async function healthcheck(cfg: Config, kind: HealthcheckKind, log: Logger, body?: string): Promise<void> {
  if (!cfg.healthchecksUrl) return;
  const base = cfg.healthchecksUrl.replace(/\/+$/, '');
  const target = kind === 'success' ? base : `${base}/${kind}`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      body: body?.slice(0, 10_000),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) log.warn({ status: res.status, kind }, 'healthchecks ping was not accepted');
  } catch (err) {
    log.warn({ error: (err as Error).name, kind }, 'healthchecks ping failed');
  }
}

function ensureSlash(u: string): string {
  return u.endsWith('/') ? u : `${u}/`;
}
