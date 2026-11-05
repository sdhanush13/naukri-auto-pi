/**
 * Tiny local imitation of the parts of Naukri the flow touches. It uses the same paths and
 * selectors as src/selectors.ts, so the real flow code runs against it unchanged.
 *
 * Modes (set per test):
 *   normal    - login works, upload works
 *   otp       - login leads to an OTP page
 *   captcha   - login page shows a CAPTCHA challenge
 *   badcreds  - login shows an inline error
 *   uploadfail- upload never shows the success message
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MockMode = 'normal' | 'otp' | 'captcha' | 'badcreds' | 'uploadfail';

export interface MockState {
  mode: MockMode;
  logins: number;
  uploads: { name: string; size: number }[];
  headline: string;
  summary: string;
  updatedToday: boolean;
  fileName: string;
}

const PAGES = join(dirname(fileURLToPath(import.meta.url)), 'pages');
const page = (name: string): string => readFileSync(join(PAGES, name), 'utf8');

export const MOCK_USER = 'tester@example.com';
export const MOCK_PASSWORD = 'correct horse battery staple';
const SESSION = 'nauk_mock_session=valid';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface MockSite {
  baseUrl: string;
  state: MockState;
  reset(mode?: MockMode): void;
  close(): Promise<void>;
}

export async function startMockSite(): Promise<MockSite> {
  const state: MockState = {
    mode: 'normal',
    logins: 0,
    uploads: [],
    headline: 'Old headline',
    summary: 'Old summary text that is long enough to be a realistic profile summary.',
    updatedToday: false,
    fileName: 'old-resume.pdf',
  };

  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  };
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const loggedIn = (req.headers.cookie ?? '').includes(SESSION);
    try {
      if (req.method === 'GET' && url.pathname === '/nlogin/login') {
        return send(res, 200, page('login.html').replace('{{CAPTCHA}}', state.mode === 'captcha' ? page('captcha-fragment.html') : ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const { username, password } = JSON.parse(await body(req)) as { username: string; password: string };
        if (state.mode === 'otp') return json(res, 200, { next: '/otp' });
        if (state.mode === 'badcreds' || username !== MOCK_USER || password !== MOCK_PASSWORD) {
          return json(res, 401, { error: 'Invalid details. Please check the Email ID - Password combination.' });
        }
        state.logins += 1;
        return json(res, 200, { next: '/mnjuser/homepage' }, { 'set-cookie': `${SESSION}; Path=/; HttpOnly` });
      }
      if (req.method === 'GET' && url.pathname === '/otp') return send(res, 200, page('otp.html'));
      if (req.method === 'GET' && url.pathname === '/mnjuser/homepage') {
        if (!loggedIn) return send(res, 302, '', { location: '/nlogin/login' });
        return send(res, 200, '<!doctype html><title>Home</title><h1>Welcome back</h1>');
      }
      if (req.method === 'GET' && url.pathname === '/mnjuser/profile') {
        if (!loggedIn) return send(res, 302, '', { location: '/nlogin/login' });
        const html = page('profile.html')
          .replace('{{HEADLINE}}', esc(state.headline))
          .replace('{{SUMMARY}}', esc(state.summary))
          .replace('{{FILENAME}}', esc(state.fileName))
          .replace('{{UPDATED}}', state.updatedToday ? 'Today' : '12 Oct 2026')
          .replace('{{UPLOADFAIL}}', state.mode === 'uploadfail' ? 'true' : 'false');
        return send(res, 200, html);
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if (!loggedIn) return json(res, 401, {});
        const { name, size } = JSON.parse(await body(req)) as { name: string; size: number };
        state.uploads.push({ name, size });
        state.fileName = name;
        state.updatedToday = true;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/profile') {
        if (!loggedIn) return json(res, 401, {});
        const { field, value } = JSON.parse(await body(req)) as { field: 'headline' | 'summary'; value: string };
        state[field] = value;
        state.updatedToday = true;
        return json(res, 200, { ok: true });
      }
      send(res, 404, 'not found');
    } catch (err) {
      send(res, 500, String(err));
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    reset(mode: MockMode = 'normal') {
      Object.assign(state, {
        mode,
        logins: 0,
        uploads: [],
        headline: 'Old headline',
        summary: 'Old summary text that is long enough to be a realistic profile summary.',
        updatedToday: false,
        fileName: 'old-resume.pdf',
      });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
