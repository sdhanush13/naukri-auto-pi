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
  /** Optional (YYYY-MM-DD). If set, "What is your age?" is answered with your age on that day. */
  dateOfBirth: z.iso.date().optional(),
});

/** Whole years between dateOfBirth (YYYY-MM-DD) and now, in local time. */
export function ageOn(dateOfBirth: string, now: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A rule phrase matches when every one of its words occurs in the question as a whole word, in
 * any order: "current ctc" matches "What is your current annual CTC?". Put specific rules
 * ("current ctc lakhs") before general ones ("current ctc"): the first match wins.
 */
export function phraseMatches(phrase: string, question: string): boolean {
  const text = ` ${norm(question)} `;
  return norm(phrase)
    .split(' ')
    .every((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`).test(text));
}

export async function resolveAnswer(
  q: Question,
  answers: Answers,
  ask?: AskModel,
  now: Date = new Date(),
): Promise<Resolution> {
  if (answers.dateOfBirth && (phraseMatches('age', q.text) || /how old/i.test(q.text))) {
    const fitted = fitAnswer(q, String(ageOn(answers.dateOfBirth, now)));
    if (fitted !== null) return { ok: true, answer: fitted, source: 'rule' };
  }
  // Per-skill years first: "How many years of experience do you have in C#?" must not get the
  // total-experience rule.
  const years = skillYears(q, answers);
  if (years !== null) {
    const fitted = fitAnswer(q, years);
    if (fitted !== null) return { ok: true, answer: fitted, source: 'skill' };
  }
  // "Years of experience in Docker?" with no "Docker" in skills must not get your total
  // experience from an "experience" rule; it goes to the model (or is skipped) instead.
  const specificYears =
    years === null &&
    YEARS_Q.test(q.text) &&
    /\b(experience|exp|worked|working)\b.*\b(in|with|on|using)\s+[a-z0-9.#+]/i.test(q.text) &&
    !/\b(total|overall|industry|it experience|professional experience|relevant experience)\b/i.test(q.text);
  for (const rule of answers.rules) {
    if (specificYears && rule.match.some((m) => /\bexp(erience)?\b/i.test(m))) continue;
    if (rule.match.some((m) => phraseMatches(m, q.text))) {
      const fitted = fitAnswer(q, rule.answer);
      if (fitted !== null) return { ok: true, answer: fitted, source: 'rule' };
      return { ok: false, reason: `saved answer "${rule.answer}" fits none of the options` };
    }
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
