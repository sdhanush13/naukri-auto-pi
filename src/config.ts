import { open, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_CONFIG_PATH = '/etc/naukri-refresher/config.json';
export const MAX_RESUME_BYTES = 2 * 1024 * 1024;
export const RESUME_EXTENSIONS: readonly string[] = ['.pdf', '.doc', '.docx'];

const notifySchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('ntfy'),
    server: z.url().default('https://ntfy.sh'),
    // Anyone who knows a public ntfy.sh topic can read it, so it should be long and random.
    topic: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'ntfy topic may only contain letters, digits, "_" and "-" (max 64)'),
  }),
  z.strictObject({
    provider: z.literal('telegram'),
    // The bot token is a secret and lives in the "telegram-bot-token" credential, not here.
    chatId: z.string().regex(/^(-?\d+|@\w+)$/, 'telegram chatId must be numeric or @channelname'),
  }),
  z.strictObject({ provider: z.literal('none') }),
]);

const applySearchSchema = z.strictObject({
  /** Naukri search keywords, e.g. "senior .net developer". */
  keywords: z.string().trim().min(2).max(100),
  /** City as Naukri spells it in URLs, e.g. "bangalore". Omit with remote: true for all-India remote. */
  location: z.string().trim().min(2).max(50).optional(),
  /** Only work-from-home / remote jobs. */
  remote: z.boolean().default(false),
});

export const applySchema = z.strictObject({
  /**
   * "off": never runs. "dry-run": search and report what it would apply to, apply to nothing.
   * "auto": apply (within maxPerDay). With autoFrom set, "auto" behaves as "dry-run" until that date.
   */
  mode: z.enum(['off', 'dry-run', 'auto']).default('dry-run'),
  autoFrom: z.iso.date().optional(),
  /** systemd OnCalendar for the apply timer (separate from the refresher's "schedule"). */
  schedule: z.string().trim().min(1).default('Mon..Fri 11:00'),
  searches: z.array(applySearchSchema).min(1).max(10),
  /** Your total experience in years; passed to Naukri's search and used to filter job ranges. */
  experienceYears: z.number().int().min(0).max(40),
  /** Only jobs posted within this many days (Naukri freshness filter). */
  jobAgeDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(15), z.literal(30)]).default(3),
  /** Hard cap on applications per calendar day. */
  maxPerDay: z.number().int().min(1).max(25).default(10),
  /** Skip jobs whose title contains any of these (case-insensitive), e.g. "intern", "java". */
  excludeTitleWords: z.array(z.string().trim().min(1)).default([]),
  /** If set, the title must contain at least one of these, e.g. ".net", "dotnet", "c#". */
  requireTitleWords: z.array(z.string().trim().min(1)).default([]),
  excludeCompanies: z.array(z.string().trim().min(1)).default([]),
  /** Your saved answers and profile facts (personal; lives next to config.json, not in git). */
  answersPath: z.string().min(1).default('/etc/naukri-refresher/answers.json'),
  /** Local model (Ollama on the Pi) for questions without a saved answer. Omit to skip those jobs. */
  llm: z
    .strictObject({
      url: z.url().default('http://naukri-ollama:11434'),
      model: z.string().min(1).default('qwen2.5:3b'),
      timeoutSeconds: z.number().int().min(10).max(1800).default(600),
    })
    .optional(),
  /** Fixed pause between job pages, to keep the pace human-like and gentle on the site. */
  pauseSeconds: z.number().int().min(2).max(120).default(8),
});

export type ApplyConfig = z.output<typeof applySchema>;

export const configSchema = z.strictObject({
  resumePath: z
    .string()
    .min(1)
    .refine((p) => RESUME_EXTENSIONS.includes(extname(p).toLowerCase()), {
      message: 'resumePath must end in .pdf, .doc or .docx',
    }),
  headline: z
    .string()
    .trim()
    .max(250, 'headline must be at most 250 characters')
    .refine((s) => s.split(/\s+/).filter(Boolean).length >= 5, 'headline must have at least 5 words (Naukri rule)')
    .optional(),
  summary: z
    .string()
    .trim()
    .min(50, 'summary must be at least 50 characters')
    .max(1000, 'summary must be at most 1000 characters (Naukri limit)')
    .optional(),
  /** systemd OnCalendar expression; applied to the timer by scripts/install.sh. */
  schedule: z.string().trim().min(1).default('Mon..Fri 10:00'),
  notify: notifySchema.default({ provider: 'none' }),
  healthchecksUrl: z.url().optional(),
  stateDir: z.string().min(1).default('/var/lib/naukri-refresher'),
  /** Overridable only so tests can point the flow at the local mock site. */
  baseUrl: z.url().default('https://www.naukri.com'),
  retryDelaySeconds: z.number().int().min(0).max(900).default(60),
  /**
   * Hard cap on real attempts per calendar day (all runs + retries together). Default 2 = one
   * daily run plus its retry. For N scheduled runs a day, N + 1 leaves room for one retry.
   */
  maxAttemptsPerDay: z.number().int().min(1).max(6).default(2),
  /**
   * "headless" (default) or "headed": a normal visible Chromium on a virtual X display (Xvfb).
   * Opt-in only. Naukri's bot protection (Akamai) answers headless Chromium with "Access Denied";
   * headed mode is an unmodified browser, but using it to get past that block is the owner's
   * deliberate, accepted trade-off (see README, "Browser mode").
   */
  browserMode: z.enum(['headless', 'headed']).default('headless'),
  /** Optional job auto-apply (run with --task apply). */
  apply: applySchema.optional(),
  timeouts: z
    .strictObject({
      navigationMs: z.number().int().positive().default(45_000),
      actionMs: z.number().int().positive().default(20_000),
      uploadMs: z.number().int().positive().default(90_000),
    })
    .prefault({}),
});

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

/** File signatures, so a renamed text file or a broken download is caught before uploading. */
const MAGIC: Record<string, Buffer[]> = {
  '.pdf': [Buffer.from('%PDF')],
  '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.doc': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
};

/** Resume must exist, be a regular file, be PDF/DOC/DOCX, be non-empty and at most 2 MB. */
export async function checkResumeFile(path: string): Promise<{ sizeBytes: number }> {
  const ext = extname(path).toLowerCase();
  if (!RESUME_EXTENSIONS.includes(ext)) {
    throw new ConfigError(`Resume ${path} must be .pdf, .doc or .docx`);
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ConfigError(`Resume file not found or not readable: ${path}`);
  }
  if (!info.isFile()) throw new ConfigError(`Resume path is not a file: ${path}`);
  if (info.size === 0) throw new ConfigError(`Resume file is empty: ${path}`);
  if (info.size > MAX_RESUME_BYTES) {
    throw new ConfigError(
      `Resume is ${(info.size / 1024 / 1024).toFixed(2)} MB; Naukri allows at most 2 MB: ${path}`,
    );
  }
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    const ok = (MAGIC[ext] ?? []).some((m) => head.subarray(0, m.length).equals(m));
    if (!ok) throw new ConfigError(`Resume ${path} does not look like a real ${ext} file`);
  } finally {
    await handle.close();
  }
  return { sizeBytes: info.size };
}
