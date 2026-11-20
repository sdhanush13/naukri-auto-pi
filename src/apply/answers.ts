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
  /\b(ctc|salary|compensation|package|lpa|lakhs?|lacs?|notice|joining|join\b|last working|lwd\b|relieving|date of birth|dob|age\b|gender|marital|married|aadhaa?r|pan\b|passport|address|phone|mobile|e-?mail|linkedin|nationality|religion|caste|disabilit|visa|bond|offer in hand|serving)/i;

/** Lower-case, single spaces, and one spelling for words Naukri recruiters spell many ways. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b(lacs?|lakh|lakhs)\b/g, 'lakhs')
    .replace(/\bbangalore\b/g, 'bengaluru')
    .trim();

type Span = { lo: number; hi: number };
const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * The numeric span an option covers, e.g. "3-5 years" → 3..5, "5+" / "more than 5" → 5..∞,
 * "<5" / "less than 5" → 0..5, "Immediate" → 0..0, "2 months" → 2..2. With `days`, months
 * are converted to days so "60 days" can pick "1-2 months".
 */
function optionSpan(option: string, days: boolean): Span | null {
  const o = norm(option);
  const unit = days && /\bmonths?\b/.test(o) ? 30 : 1;
  if (days && /\b(immediate|immediately|serving)\b/.test(o)) return { lo: 0, hi: /serving/.test(o) ? 0 : 7 };
  let m = new RegExp(`${NUM}\\s*(?:-|to|–)\\s*${NUM}`).exec(o);
  if (m) return { lo: +m[1]! * unit, hi: +m[2]! * unit };
  m = new RegExp(`(?:>|more than|above|over|greater than|at least)\\s*${NUM}|${NUM}\\s*(?:\\+|or more|and above|& above|plus)`).exec(o);
  if (m) return { lo: +(m[1] ?? m[2])! * unit, hi: Infinity };
  m = new RegExp(`(?:<|less than|below|under|upto|up to|within)\\s*${NUM}|${NUM}\\s*(?:or less|and below|& below)`).exec(o);
  if (m) return { lo: 0, hi: +(m[1] ?? m[2])! * unit };
  m = new RegExp(`^${NUM}\\b`).exec(o);
  if (m) return { lo: +m[1]! * unit, hi: +m[1]! * unit };
  return null;
}

/** "60 days" → 60, "2 months" → 60, "Immediate" → 0; null if not a duration. */
function durationDays(answer: string): number | null {
  const a = norm(answer);
  if (/^(immediate|immediately|0 days?)$/.test(a)) return 0;
  const m = new RegExp(`^${NUM}\\s*(days?|months?)\\b`).exec(a);
  return m ? +m[1]! * (m[2]!.startsWith('month') ? 30 : 1) : null;
}

/** Picks the option that matches an answer: exact, yes/no, numeric span, then containment. */
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
  // Durations ("60 days") and plain numbers ("5.3") against spans like "1-2 months", "5+ years".
  const d = durationDays(a);
  const n = d ?? (/^\d+(?:\.\d+)?\b/.test(a) ? Number.parseFloat(a) : NaN);
  if (Number.isFinite(n)) {
    const fits = options.filter((o) => {
      const s = optionSpan(o, d !== null);
      return s !== null && n >= s.lo && n <= s.hi;
    });
    // On a shared edge ("3-5" and "5-7" for 5) prefer the span that starts at the value.
    if (fits.length) return fits.find((o) => optionSpan(o, d !== null)!.lo === n) ?? fits[0]!;
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words that don't change which skill a question is about ("C# development", ".NET 8 apps"). */
const FILLER = new Set(
  (
    'a an the and or of in on with using as for your you do have has how many much what is are total overall ' +
    'relevant hands-on hands experience exp years year yrs yr working worked work development developer developers ' +
    'engineer engineering programming coding application applications app apps based architecture framework ' +
    'frameworks technologies technology stack full fullstack language languages version versions projects project ' +
    'tools tool environment api apis platform platforms services core'
  ).split(' '),
);

/**
 * The skill(s) a question asks about, if it is about known skills only. "Years in Azure
 * Service Bus?" → [4]; "Years in Azure Data Factory?" → null ("data factory" is unknown, and
 * answering with your Azure years would overstate). Text after the last "in/with/as/of" is the
 * subject; "SQL/Oracle" style alternatives are checked separately when `anyAlternative`.
 */
function knownSkillYears(text: string, answers: Answers, anyAlternative: boolean): number[] | null {
  const t = norm(text).replace(/\?+\s*$/, '');
  const preps = [...t.matchAll(/\b(?:in|with|as|of|on|using)\s+/g)];
  const subject = preps.length ? t.slice(preps.at(-1)!.index! + preps.at(-1)![0].length) : t;
  const alternatives = anyAlternative ? subject.split(/\s*\/\s*|\s+or\s+/) : [subject];
  // Longest skill name first, so "Azure Functions" beats "Azure".
  const names = Object.keys(answers.skills).sort((a, b) => b.length - a.length);
  let best: number[] | null = null;
  for (const alt of alternatives) {
    let rest = ` ${alt} `;
    const found: number[] = [];
    for (const name of names) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(norm(name))}(?=[^a-z0-9]|$)`, 'g');
      if (re.test(rest)) {
        found.push(answers.skills[name]!);
        rest = rest.replace(re, '$1 ');
      }
    }
    const leftover = rest
      .split(/[^a-z0-9#+.-]+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w && !FILLER.has(w) && !/^\d+(\.\d+)?x?$/.test(w));
    if (found.length && leftover.length === 0 && (!best || Math.min(...found) > Math.min(...best))) best = found;
  }
  return best;
}

function skillYears(q: Question, answers: Answers): string | null {
  if (!YEARS_Q.test(q.text)) return null;
  const found = knownSkillYears(q.text, answers, false);
  // Several skills in one question ("C# and React"): the smallest, so it never overstates.
  return found ? String(Math.min(...found)) : null;
}

/** "Do you have experience in SQL/Oracle?" → Yes when the profile lists one of them. */
const HAVE_EXPERIENCE_Q = /^(do|have|are) you (have |got )?(any |good |hands-on |prior |working )*(experience|exposure|worked|familiar|knowledge)\b/i;

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
  if (!YEARS_Q.test(q.text) && HAVE_EXPERIENCE_Q.test(q.text.trim()) && knownSkillYears(q.text, answers, true)?.some((y) => y > 0)) {
    const fitted = fitAnswer(q, 'Yes');
    if (fitted !== null) return { ok: true, answer: fitted, source: 'skill' };
  }
  // "Years of experience in Docker?" must not get your total experience from an "experience"
  // rule (whether or not Docker is in skills); it goes to the model (or is skipped) instead.
  const specificYears =
    YEARS_Q.test(q.text) &&
    /\b(experience|exp|worked|working)\b.*\b(in|with|on|using|as)\s+[a-z0-9.#+]/i.test(q.text) &&
    !/\b(total|overall|industry|it experience|professional experience|relevant experience)\b/i.test(q.text);
  // A saved answer that fits none of the options ("Yes" for "select your city") falls through
  // to the next matching rule, then the model; the first such miss is reported if all fail.
  let unfit: string | null = null;
  for (const rule of answers.rules) {
    if (specificYears && rule.match.some((m) => /\bexp(erience)?\b/i.test(m))) continue;
    if (rule.match.some((m) => phraseMatches(m, q.text))) {
      const fitted = fitAnswer(q, rule.answer);
      if (fitted !== null) return { ok: true, answer: fitted, source: 'rule' };
      unfit ??= `saved answer "${rule.answer}" fits none of the options (${q.options?.join(' / ') ?? q.kind})`;
    }
  }
  if (SENSITIVE.test(q.text)) return { ok: false, reason: unfit ?? 'personal question without a saved answer' };
  if (!ask) return { ok: false, reason: unfit ?? 'no saved answer (local model disabled)' };
  let raw: string | null;
  try {
    raw = await ask(q, answers.profile);
  } catch (err) {
    return { ok: false, reason: `local model failed: ${(err as Error).message}` };
  }
  if (raw === null || raw.trim() === '') return { ok: false, reason: unfit ?? 'local model: profile does not answer it' };
  const fitted = fitAnswer(q, raw);
  if (fitted === null) return { ok: false, reason: unfit ?? `local model answer "${raw}" fits none of the options (${q.options?.join(' / ') ?? q.kind})` };
  return { ok: true, answer: fitted, source: 'llm' };
}
