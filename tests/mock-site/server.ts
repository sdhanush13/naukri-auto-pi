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

export interface MockQuestion {
  text: string;
  kind: 'text' | 'radio' | 'checkbox';
  options?: string[];
}

export interface MockJob {
  id: string;
  title: string;
  company: string;
  exp: string;
  loc: string;
  kind: 'apply' | 'company' | 'applied';
  questions?: MockQuestion[];
}

/** Search results for the apply flow (one page; every search returns the same list). */
export const MOCK_JOBS: MockJob[] = [
  { id: '100', title: 'Senior .NET Developer', company: 'Acme', exp: '4-8 Yrs', loc: 'Bengaluru', kind: 'apply' },
  {
    id: '101', title: 'Senior Dotnet Engineer', company: 'Beta', exp: '3-6 Yrs', loc: 'Bengaluru', kind: 'apply',
    questions: [
      { text: 'What is your notice period?', kind: 'text' },
      { text: 'Are you willing to relocate?', kind: 'radio', options: ['Yes', 'No'] },
      { text: 'How many years of experience do you have in C#?', kind: 'text' },
      { text: 'Which clouds have you used?', kind: 'checkbox', options: ['AWS', 'Azure', 'GCP'] },
    ],
  },
  { id: '102', title: 'Java Developer', company: 'Gamma', exp: '4-8 Yrs', loc: 'Bengaluru', kind: 'apply' },
  { id: '103', title: '.NET Lead', company: 'Delta', exp: '5-9 Yrs', loc: 'Remote', kind: 'company' },
  { id: '104', title: 'Senior .NET Developer', company: 'Epsilon', exp: '5-10 Yrs', loc: 'Bengaluru', kind: 'applied' },
  {
    id: '105', title: '.NET Azure Developer', company: 'Zeta', exp: '4-7 Yrs', loc: 'Bengaluru', kind: 'apply',
    questions: [{ text: 'What is your current CTC?', kind: 'text' }],
  },
  { id: '107', title: 'Senior .NET Developer', company: 'Acme', exp: '4-8 Yrs', loc: 'Bengaluru', kind: 'apply' }, // repost of 100
  { id: '106', title: 'Principal .NET Architect', company: 'Eta', exp: '10-15 Yrs', loc: 'Bengaluru', kind: 'apply' },
];

export type MockMode = 'normal' | 'otp' | 'captcha' | 'badcreds' | 'uploadfail';

export interface MockState {
  mode: MockMode;
  logins: number;
  uploads: { name: string; size: number }[];
  headline: string;
  summary: string;
  updatedToday: boolean;
  fileName: string;
  /** Times the summary "Delete" link was used; the flow must never click it. */
  deletes: number;
  applications: { id: string; answers: { q: string; a: string }[] }[];
  searches: string[];
  /** Applications Naukri accepts before answering "daily quota has been expired". */
  quota: number;
  llmCalls: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');
/** Top card format: "05Nov, 2026". */
export const topCardDate = (d: Date): string => `${pad(d.getDate())}${MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
/** Resume card format: "Nov 05, 2026". */
export const resumeCardDate = (d: Date): string => `${MONTHS[d.getMonth()]} ${pad(d.getDate())}, ${d.getFullYear()}`;
const OLD = new Date(2026, 9, 12);
const FRESH = {
  logins: 0,
  headline: 'Old headline',
  summary: 'Old summary text that is long enough to be a realistic profile summary.',
  updatedToday: false,
  fileName: 'old-resume.pdf',
  deletes: 0,
  quota: 50,
  llmCalls: 0,
};

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
  const state: MockState = { mode: 'normal', uploads: [], applications: [], searches: [], ...FRESH };

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
          .replace('{{UPDATED}}', topCardDate(state.updatedToday ? new Date() : OLD))
          .replace('{{UPLOADED_ON}}', resumeCardDate(state.uploads.length ? new Date() : OLD))
          .replace('{{UPLOADFAIL}}', state.mode === 'uploadfail' ? 'true' : 'false');
        return send(res, 200, html);
      }
      if (req.method === 'POST' && url.pathname === '/api/resume/upload') {
        if (!loggedIn) return json(res, 401, {});
        const { name, size } = JSON.parse(await body(req)) as { name: string; size: number };
        state.uploads.push({ name, size });
        state.fileName = name;
        state.updatedToday = true;
        return json(res, 200, { uploadedOn: resumeCardDate(new Date()), updated: topCardDate(new Date()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/profile') {
        if (!loggedIn) return json(res, 401, {});
        const { field, value } = JSON.parse(await body(req)) as { field: 'headline' | 'summary'; value: string };
        if (field === 'summary' && value === '') state.deletes += 1;
        state[field] = value;
        state.updatedToday = true;
        return json(res, 200, { updated: topCardDate(new Date()) });
      }
      if (req.method === 'GET' && /-jobs(-in-[a-z0-9-]+)?$/.test(url.pathname)) {
        state.searches.push(url.pathname + url.search);
        const cards = MOCK_JOBS.map(
          (j) => `<div class="srp-jobtuple-wrapper" data-job-id="${j.id}"><div class="cust-job-tuple"><h2><a class="title" title="${esc(j.title)}" href="/job-listings-${j.id}">${esc(j.title)}</a></h2><a class="comp-name">${esc(j.company)}</a><span class="exp-wrap"><span class="expwdth">${j.exp}</span></span><span class="loc-wrap"><span class="locWdth">${esc(j.loc)}</span></span></div></div>`,
        ).join('');
        return send(res, 200, `<!doctype html><title>Search</title>${cards}`);
      }
      const jobMatch = /^\/job-listings-(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && jobMatch) {
        const job = MOCK_JOBS.find((j) => j.id === jobMatch[1]);
        if (!job) return send(res, 404, 'no job');
        const applied = job.kind === 'applied' || state.applications.some((a) => a.id === job.id);
        const button = applied
          ? '<span id="already-applied">Applied</span>'
          : job.kind === 'company'
            ? '<button id="company-site-button">Apply on company site</button>'
            : '<button id="apply-button" class="apply-button">Apply</button>';
        const html = page('job.html')
          .replace('{{TITLE}}', esc(job.title))
          .replace('{{COMPANY}}', esc(job.company))
          .replace('{{BUTTON}}', button)
          .replace('{{JOB_ID}}', JSON.stringify(job.id))
          .replace('{{QUESTIONS}}', JSON.stringify(job.questions ?? []))
          .replace('{{QUOTA}}', 'false');
        return send(res, 200, html);
      }
      if (req.method === 'POST' && url.pathname === '/api/apply') {
        if (!loggedIn) return json(res, 401, {});
        const data = JSON.parse(await body(req)) as { id: string; answers: { q: string; a: string }[] };
        if (state.applications.length >= state.quota) return json(res, 200, { quota: true });
        state.applications.push(data);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        // Fake Ollama: knows the cloud question, says null (unknown) to everything else.
        const prompt = JSON.stringify(JSON.parse(await body(req)));
        state.llmCalls += 1;
        const answer = /which clouds/i.test(prompt) ? 'Azure' : null;
        return json(res, 200, { message: { content: JSON.stringify({ answer }) } });
      }
      if (req.method === 'GET' && url.pathname === '/myapply/saveApply') {
        return send(res, 200, '<!doctype html><title>Applied</title><p>You have successfully applied to the job.</p>');
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
      Object.assign(state, { mode, uploads: [], applications: [], searches: [], ...FRESH });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
