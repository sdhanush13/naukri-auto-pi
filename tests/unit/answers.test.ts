import { describe, expect, it, vi } from 'vitest';
import { type Answers, answersSchema, pickOption, resolveAnswer } from '../../src/apply/answers.js';
import { buildPrompt, ollamaAsker } from '../../src/apply/llm.js';

const answers: Answers = answersSchema.parse({
  profile: 'Senior Software Engineer, 5 years of C#, .NET and Azure. Based in Bengaluru. MCA degree.',
  rules: [
    { match: ['notice period'], answer: '60 days' },
    { match: ['total experience', 'years of experience do you have'], answer: '5' },
    { match: ['relocate'], answer: 'Yes' },
  ],
  skills: { 'C#': 5, Azure: 5, 'Azure Functions': 4, '.NET': 5 },
});

describe('pickOption', () => {
  it('matches exact, yes/no and numeric ranges', () => {
    expect(pickOption('Yes', ['Yes', 'No'])).toBe('Yes');
    expect(pickOption('willing', ['Yes, I am', 'No'])).toBe('Yes, I am');
    expect(pickOption('5', ['0-2 years', '3-5 years', '6+ years'])).toBe('3-5 years');
    expect(pickOption('7', ['0-2 years', '3-5 years', '6+ years'])).toBe('6+ years');
    expect(pickOption('maybe', ['Yes', 'No'])).toBeNull();
  });
});

describe('resolveAnswer', () => {
  it('uses saved rules first, fitted to the question type', async () => {
    expect(await resolveAnswer({ text: 'What is your notice period?', kind: 'text' }, answers)).toEqual({
      ok: true, answer: '60 days', source: 'rule',
    });
    expect(await resolveAnswer({ text: 'Notice period (in days)', kind: 'number' }, answers)).toMatchObject({ answer: '60' });
    expect(
      await resolveAnswer({ text: 'Are you willing to relocate?', kind: 'radio', options: ['Yes', 'No'] }, answers),
    ).toMatchObject({ answer: 'Yes' });
  });

  it('answers per-skill years, preferring the longest skill name', async () => {
    const r = await resolveAnswer({ text: 'How many years of experience do you have in Azure Functions?', kind: 'number' }, answers);
    // "years of experience do you have" is a total-experience rule, so rules win; use a skill phrasing instead:
    expect(r.ok).toBe(true);
    expect(
      await resolveAnswer({ text: 'Years of experience in Azure Functions', kind: 'number' }, answers),
    ).toEqual({ ok: true, answer: '4', source: 'skill' });
    expect(await resolveAnswer({ text: 'Experience in C# (years)', kind: 'number' }, answers)).toMatchObject({
      answer: '5', source: 'skill',
    });
  });

  it('never sends personal questions to the model', async () => {
    const ask = vi.fn(async () => '25 LPA');
    for (const text of ['What is your current CTC?', 'Expected salary?', 'Date of birth', 'Your PAN number']) {
      const r = await resolveAnswer({ text, kind: 'text' }, answers, ask);
      expect(r.ok).toBe(false);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips when the model says the profile does not answer it', async () => {
    const r = await resolveAnswer({ text: 'Rate your Kubernetes skills', kind: 'text' }, answers, async () => null);
    expect(r).toMatchObject({ ok: false });
  });

  it('accepts a model answer only if it fits the options', async () => {
    const q = { text: 'Have you worked on Azure?', kind: 'radio' as const, options: ['Yes', 'No'] };
    expect(await resolveAnswer(q, answers, async () => 'Yes')).toEqual({ ok: true, answer: 'Yes', source: 'llm' });
    expect(await resolveAnswer(q, answers, async () => 'Somewhat')).toMatchObject({ ok: false });
  });

  it('skips without a model', async () => {
    expect(await resolveAnswer({ text: 'Why do you want to join us?', kind: 'text' }, answers)).toMatchObject({ ok: false });
  });
});

describe('ollamaAsker', () => {
  it('sends a JSON schema with the options and maps null to "unknown"', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const fake = (async (_url: unknown, init: { body: string }) => {
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ message: { content: '{"answer": null}' } }));
    }) as unknown as typeof fetch;
    const ask = ollamaAsker({ url: 'http://x:11434', model: 'm', timeoutSeconds: 10 }, fake);
    const q = { text: 'Know Rust?', kind: 'radio' as const, options: ['Yes', 'No'] };
    expect(await ask(q, 'profile')).toBeNull();
    const body = calls[0]!.body as { format: { properties: { answer: { anyOf: { enum?: string[] }[] } } }; options: { temperature: number } };
    expect(body.format.properties.answer.anyOf[0]!.enum).toEqual(['Yes', 'No']);
    expect(body.options.temperature).toBe(0);
    expect(buildPrompt(q)).toContain('Options: "Yes", "No"');
  });
});
