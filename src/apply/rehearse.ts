import type { Config } from '../config.js';
import { ExitCode, type ExitCodeValue } from '../exitCodes.js';
import type { Logger } from '../logger.js';
import { type Question, loadAnswers, resolveAnswer } from './answers.js';
import { ollamaAsker } from './llm.js';

/** Typical Naukri screening questions, to check answers.json and the local model before going live. */
export const SAMPLE_QUESTIONS: Question[] = [
  { text: 'How many years of experience do you have?', kind: 'number' },
  { text: 'What is your notice period?', kind: 'text' },
  { text: 'What is your current CTC?', kind: 'text' },
  { text: 'What is your expected CTC?', kind: 'text' },
  { text: 'Are you willing to relocate?', kind: 'radio', options: ['Yes', 'No'] },
  { text: 'What is your current location?', kind: 'text' },
  { text: 'How many years of experience do you have in C#?', kind: 'number' },
  { text: 'Years of experience in Azure Functions', kind: 'number' },
  { text: 'How many years of experience in Kubernetes?', kind: 'number' },
  { text: 'Have you worked on microservices architecture?', kind: 'radio', options: ['Yes', 'No'] },
  { text: 'Rate yourself in SQL Server out of 10', kind: 'number' },
  { text: 'Do you have experience with Java?', kind: 'radio', options: ['Yes', 'No'] },
  { text: 'Briefly describe your experience with Azure.', kind: 'text' },
  { text: 'Are you comfortable working from office in Bangalore?', kind: 'radio', options: ['Yes', 'No'] },
];

export async function rehearse(cfg: Config, log: Logger, questions = SAMPLE_QUESTIONS): Promise<ExitCodeValue> {
  if (!cfg.apply) {
    log.error('no "apply" section in config.json');
    return ExitCode.Failure;
  }
  const { answers } = await loadAnswers(cfg.apply.answersPath);
  const ask = cfg.apply.llm ? ollamaAsker(cfg.apply.llm) : undefined;
  for (const q of questions) {
    const started = Date.now();
    const r = await resolveAnswer(q, answers, ask);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(
      r.ok ? `✔ ${q.text}\n    → ${r.answer}   [${r.source}, ${secs}s]\n` : `✖ ${q.text}\n    → SKIP JOB: ${r.reason}   [${secs}s]\n`,
    );
  }
  return ExitCode.Success;
}
