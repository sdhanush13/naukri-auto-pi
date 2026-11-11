import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * answers.json: the facts the apply flow may use. Personal, kept on the Pi next to config.json
 * (never in git). Every answer sent to an employer comes from here, either directly (rules,
 * skills) or via the local model, which is only shown `profile` and must answer "unknown" when
 * the profile does not say.
 */
export const answersSchema = z.strictObject({
  /** Plain-text facts about you (from your resume). The only context the local model sees. */
  profile: z.string().trim().min(50).max(6000),
  /** Saved answers. First rule whose `match` phrase occurs in the question wins. */
  rules: z
    .array(
      z.strictObject({
        match: z.array(z.string().trim().min(2)).min(1),
        answer: z.string().trim().min(1),
      }),
    )
    .default([]),
  /** Years per skill, for "How many years of experience do you have in X?". */
  skills: z.record(z.string().trim().min(1), z.number().min(0).max(40)).default({}),
});

export type Answers = z.output<typeof answersSchema>;

export async function loadAnswers(path: string): Promise<{ answers: Answers; hash: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read answers file ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  const parsed = answersSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid answers file ${path}:\n${z.prettifyError(parsed.error)}`);
  return { answers: parsed.data, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

export type QuestionKind = 'text' | 'number' | 'radio' | 'checkbox';

export interface Question {
  text: string;
  kind: QuestionKind;
  /** Choices for radio / checkbox questions, as shown on the page. */
  options?: string[];
}

export type Resolution =
  | { ok: true; answer: string; source: 'rule' | 'skill' | 'llm' }
  | { ok: false; reason: string };

/** Asks the local model. Returns null when the model says the profile doesn't answer it. */
export type AskModel = (q: Question, profile: string) => Promise<string | null>;

/**
 * Questions only you can answer. These never go to the model: without a saved rule the job is
 * skipped, so the model can't make up a salary, notice period or personal detail.
 */
const SENSITIVE =
  /\b(ctc|salary|compensation|package|lpa|lakhs?|notice|joining|join\b|date of birth|dob|age\b|gender|marital|married|aadhaa?r|pan\b|passport|address|phone|mobile|e-?mail|linkedin|nationality|religion|caste|disabilit|visa|bond|offer in hand|serving)/i;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Picks the option that matches an answer: exact, then yes/no synonyms, then containment. */
export function pickOption(answer: string, options: string[]): string | null {
  const a = norm(answer);
  const exact = options.find((o) => norm(o) === a);
  if (exact) return exact;
  const yes = /^(yes|y|true|willing|ok|sure)\b/.test(a);
  const no = /^(no|n|false|not)\b/.test(a);
  if (yes || no) {
    const hit = options.find((o) => (yes ? /^\s*yes\b/i : /^\s*no\b/i).test(o));
    if (hit) return hit;
  }
  // Numeric answers against ranges like "3-5 years", "5+ years".
  const n = Number.parseFloat(a);
  if (Number.isFinite(n)) {
    for (const o of options) {
      const range = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/.exec(o);
      if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
      const plus = /(\d+(?:\.\d+)?)\s*\+/.exec(o);
      if (plus && n >= Number(plus[1])) return o;
    }
  }
  const contains = options.filter((o) => norm(o).includes(a) || a.includes(norm(o)));
  return contains.length === 1 ? contains[0]! : null;
}

function fitAnswer(q: Question, answer: string): string | null {
  if (q.kind === 'radio' || q.kind === 'checkbox') return q.options?.length ? pickOption(answer, q.options) : null;
  if (q.kind === 'number') {
    const m = /\d+(?:\.\d+)?/.exec(answer);
    return m ? m[0] : null;
  }
  return answer;
}

const YEARS_Q = /(how many|no\.? of|number of|total)?\s*(years?|yrs?)\b.*\b(experience|exp|worked|working)\b|\bexperience\b.*\b(years?|yrs?)\b/i;

function skillYears(q: Question, answers: Answers): string | null {
  if (!YEARS_Q.test(q.text)) return null;
  const text = ` ${norm(q.text)} `;
  // Longest skill name first, so "Azure Functions" beats "Azure".
  const names = Object.keys(answers.skills).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const n = norm(name);
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text)) return String(answers.skills[name]);
  }
  return null;
}

export async function resolveAnswer(q: Question, answers: Answers, ask?: AskModel): Promise<Resolution> {
  const text = norm(q.text);
  for (const rule of answers.rules) {
    if (rule.match.some((m) => text.includes(norm(m)))) {
      const fitted = fitAnswer(q, rule.answer);
      if (fitted !== null) return { ok: true, answer: fitted, source: 'rule' };
      return { ok: false, reason: `saved answer "${rule.answer}" fits none of the options` };
    }
  }
  const years = skillYears(q, answers);
  if (years !== null) {
    const fitted = fitAnswer(q, years);
    if (fitted !== null) return { ok: true, answer: fitted, source: 'skill' };
  }
  if (SENSITIVE.test(q.text)) return { ok: false, reason: 'personal question without a saved answer' };
  if (!ask) return { ok: false, reason: 'no saved answer (local model disabled)' };
  let raw: string | null;
  try {
    raw = await ask(q, answers.profile);
  } catch (err) {
    return { ok: false, reason: `local model failed: ${(err as Error).message}` };
  }
  if (raw === null || raw.trim() === '') return { ok: false, reason: 'local model: profile does not answer it' };
  const fitted = fitAnswer(q, raw);
  if (fitted === null) return { ok: false, reason: `local model answer "${raw}" fits none of the options` };
  return { ok: true, answer: fitted, source: 'llm' };
}
