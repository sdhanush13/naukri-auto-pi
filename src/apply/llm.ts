import type { AskModel, Question } from './answers.js';

export interface LlmConfig {
  url: string;
  model: string;
  timeoutSeconds: number;
}

const SYSTEM = `You fill in job application screening questions for a candidate.
Use ONLY the candidate profile given. Never invent facts, numbers, employers or skills.
If the profile does not clearly answer the question, the answer is null.
Keep text answers short (one sentence, max 300 characters), first person, professional.
For a number question, answer with digits only (years may be decimals, e.g. 2.5).
For a choice question, answer with exactly one of the given options, or null.`;

export function buildPrompt(q: Question): string {
  const lines = [`Question: ${q.text}`, `Answer type: ${q.kind}`];
  if (q.options?.length) lines.push(`Options: ${q.options.map((o) => JSON.stringify(o)).join(', ')}`);
  return lines.join('\n');
}

function schemaFor(q: Question): object {
  const answer =
    q.options?.length && (q.kind === 'radio' || q.kind === 'checkbox')
      ? { anyOf: [{ type: 'string', enum: q.options }, { type: 'null' }] }
      : { type: ['string', 'null'] };
  return { type: 'object', properties: { answer }, required: ['answer'] };
}

/** Ollama /api/chat with a JSON schema, temperature 0 (same question → same answer). */
export function ollamaAsker(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): AskModel {
  return async (q, profile) => {
    const res = await fetchImpl(new URL('/api/chat', cfg.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        keep_alive: '10m',
        format: schemaFor(q),
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          // The profile is a fixed prefix, so Ollama reuses its cache across questions.
          { role: 'system', content: `${SYSTEM}\n\nCandidate profile:\n${profile}` },
          { role: 'user', content: buildPrompt(q) },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? '{}') as { answer?: unknown };
    const a = parsed.answer;
    if (a === null || a === undefined) return null;
    const s = String(a).trim();
    return /^(null|unknown|n\/a|not (mentioned|specified|available))$/i.test(s) ? null : s.slice(0, 300);
  };
}
