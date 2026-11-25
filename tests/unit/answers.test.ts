import { describe, expect, it, vi } from 'vitest';
import { type Answers, answersSchema, phraseMatches, pickOption, resolveAnswer } from '../../src/apply/answers.js';
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

  it('handles open-ended spans and shared edges (seen on Naukri)', () => {
    expect(pickOption('5', ['<5', '5 to 7', '7+'])).toBe('5 to 7');
    expect(pickOption('5.3', ['<5', '5 to 7', '7+'])).toBe('5 to 7');
    expect(pickOption('4', ['<5', '5 to 7', '7+'])).toBe('<5');
    expect(pickOption('5', ['Less than 1 year', '1-2 years', 'More than 2 years'])).toBe('More than 2 years');
  });

  it('maps notice-period durations onto day and month options', () => {
    const opts = ['Immediate', '15 days or less', '1 month', '2 months', '3 months', 'More than 3 months'];
    expect(pickOption('60 days', opts)).toBe('2 months');
    expect(pickOption('60 days', ['0-15 days', '15-30 days', '30-60 days', '60-90 days'])).toBe('60-90 days');
    expect(pickOption('60 days', ['Immediate', 'Less than 30 days', 'More than 30 days'])).toBe('More than 30 days');
  });

  it('treats Bangalore and Bengaluru as the same city', () => {
    expect(pickOption('Bengaluru', ['Hyderabad', 'Bangalore', 'Pune'])).toBe('Bangalore');
  });
});

describe('phraseMatches', () => {
  it('needs every word, as whole words, in any order', () => {
    expect(phraseMatches('current ctc', 'What is your current annual CTC?')).toBe(true);
    expect(phraseMatches('current ctc lakhs', 'Current CTC (in Lakhs)')).toBe(true);
    expect(phraseMatches('current ctc lakhs', 'What is your current CTC?')).toBe(false);
    expect(phraseMatches('age', 'Can you manage a team?')).toBe(false);
    expect(phraseMatches('c#', 'Rate your C# skills')).toBe(true);
    expect(phraseMatches('face to face interview', 'Are you Available for Face to Face interviews?')).toBe(true);
    expect(phraseMatches('age', 'Are you okay with the wages?')).toBe(false);
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

  it('answers per-skill years before the total-experience rule, longest skill name first', async () => {
    expect(
      await resolveAnswer({ text: 'How many years of experience do you have in Azure Functions?', kind: 'number' }, answers),
    ).toEqual({ ok: true, answer: '4', source: 'skill' });
    expect(
      await resolveAnswer({ text: 'How many years of experience do you have?', kind: 'number' }, answers),
    ).toEqual({ ok: true, answer: '5', source: 'rule' });
    expect(
      await resolveAnswer({ text: 'Years of experience in Azure Functions', kind: 'number' }, answers),
    ).toEqual({ ok: true, answer: '4', source: 'skill' });
    expect(await resolveAnswer({ text: 'Experience in C# (years)', kind: 'number' }, answers)).toMatchObject({
      answer: '5', source: 'skill',
    });
  });

  it('does not answer "years in <unknown skill>" with the total experience', async () => {
    const q = { text: 'How many years of experience in Docker?', kind: 'number' as const };
    expect(await resolveAnswer(q, answers)).toMatchObject({ ok: false });
    expect(await resolveAnswer(q, answers, async () => '2')).toEqual({ ok: true, answer: '2', source: 'llm' });
    expect(
      await resolveAnswer({ text: 'Total years of experience in the IT industry', kind: 'number' }, answers),
    ).toMatchObject({ ok: true, answer: '5', source: 'rule' });
  });

  it('computes age from dateOfBirth on the day asked', async () => {
    const a = { ...answers, dateOfBirth: '1996-02-22' };
    const q = { text: 'What is your age?', kind: 'number' as const };
    expect(await resolveAnswer(q, a, undefined, new Date(2027, 1, 21))).toMatchObject({ answer: '30' });
    expect(await resolveAnswer(q, a, undefined, new Date(2027, 1, 22))).toMatchObject({ answer: '31' });
    expect(await resolveAnswer(q, answers)).toMatchObject({ ok: false }); // no DOB saved: skipped
    expect(phraseMatches('age', 'Can you manage a team?')).toBe(false);
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
    const q = { text: 'Have you worked on Kafka?', kind: 'radio' as const, options: ['Yes', 'No'] };
    expect(await resolveAnswer(q, answers, async () => 'Yes')).toEqual({ ok: true, answer: 'Yes', source: 'llm' });
    expect(await resolveAnswer(q, answers, async () => 'Somewhat')).toMatchObject({ ok: false });
  });

  it('only uses skill years when the question names known skills and nothing else', async () => {
    const ask = vi.fn(async () => null);
    const r = (text: string) => resolveAnswer({ text, kind: 'number' }, answers, ask);
    expect(await r('How many years of experience do you have in Azure Data Factory?')).toMatchObject({ ok: false });
    expect(await r('How many years of experience do you have in Azure Functions?')).toMatchObject({ answer: '4', source: 'skill' });
    expect(await r('How many years of experience do you have in .NET 8 / .NET 9?')).toMatchObject({ answer: '5' });
    expect(await r('How many years of hands-on experience do you have in C# and .NET Core development?')).toMatchObject({ answer: '5' });
    expect(await r('How many years of experience do you have in C# and Azure Functions?')).toMatchObject({ answer: '4' });
    expect(await r('Total years of hands-on C#/.NET experience?')).toMatchObject({ answer: '5' });
  });

  it('answers "do you have experience in X" with Yes when X is a listed skill', async () => {
    const ask = vi.fn(async () => null);
    expect(await resolveAnswer({ text: 'Do you have experience in C#/Oracle', kind: 'text' }, answers, ask)).toMatchObject({ answer: 'Yes', source: 'skill' });
    expect(await resolveAnswer({ text: 'Do you have experience in Azure Data Factory?', kind: 'text' }, answers, ask)).toMatchObject({ ok: false });
  });

  it('never sends a model "No" to a skills question, but allows it for employer questions', async () => {
    const no = vi.fn(async () => 'No hands-on experience with .NET Framework 4.8 or WinForms.');
    expect(await resolveAnswer({ text: 'Do you have hands-on experience in .NET Framework 4.8 and WinForms?', kind: 'text' }, answers, no)).toMatchObject({ ok: false });
    const a = await resolveAnswer({ text: 'Have you worked at Infosys before?', kind: 'checkbox', options: ['Yes', 'No'] }, answers, async () => 'No');
    expect(a).toMatchObject({ ok: true, answer: 'No' });
  });

  it('accepts "hands on" with a space and "Azure Services"', async () => {
    const ask = vi.fn(async () => null);
    expect(await resolveAnswer({ text: 'Do you have hands on experience working on Azure API and Azure Services', kind: 'text' }, answers, ask)).toMatchObject({ answer: 'Yes' });
    expect(await resolveAnswer({ text: 'How many years of experience do you have in Azure Service?', kind: 'number' }, answers, ask)).toMatchObject({ answer: '5' });
  });

  it('matches Lacs/Lakh spellings to "lakhs" rules', async () => {
    const a = answersSchema.parse({ ...answers, rules: [{ match: ['current ctc lakhs'], answer: '28.08' }, { match: ['current ctc'], answer: '2808000' }] });
    expect(await resolveAnswer({ text: 'What is your current CTC in Lacs per annum?', kind: 'number' }, a)).toMatchObject({ answer: '28.08' });
  });

  it('falls through to the next rule when a saved answer fits no option', async () => {
    const a = answersSchema.parse({ ...answers, rules: [{ match: ['relocate'], answer: 'Yes' }, { match: ['city'], answer: 'Bengaluru' }] });
    const q = { text: 'Please select the city you are currently residing or willing to relocate to', kind: 'checkbox' as const, options: ['Hyderabad', 'Bangalore'] };
    expect(await resolveAnswer(q, a)).toMatchObject({ ok: true, answer: 'Bangalore' });
  });

  it('never sends "last working day", availability or degree questions to the model', async () => {
    const ask = vi.fn(async () => 'No');
    expect(await resolveAnswer({ text: 'What is your Official last working day?', kind: 'text' }, answers, ask)).toMatchObject({ ok: false });
    expect(await resolveAnswer({ text: 'Are you Available for Face to Face interviews?', kind: 'radio', options: ['Yes', 'No'] }, answers, ask)).toMatchObject({ ok: false });
    expect(await resolveAnswer({ text: 'Are you a fulltime graduate?', kind: 'checkbox', options: ['Yes', 'No'] }, answers, ask)).toMatchObject({ ok: false });
    expect(ask).not.toHaveBeenCalled();
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
