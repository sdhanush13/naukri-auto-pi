import type { Page } from 'playwright';
import type { ApplyConfig } from '../config.js';

export interface JobCard {
  id: string;
  title: string;
  company: string;
  url: string;
  experience: string;
  location: string;
}

/** Naukri's URL slug: ".net" → "dot-net", "c#" → "c-sharp", other symbols → "-". */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/c#/g, 'c sharp')
    .replace(/\.net/g, ' dot net')
    .replace(/\+\+/g, ' plus plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Search page URL, e.g. /senior-dot-net-developer-jobs-in-bangalore?k=...&l=...&experience=5&jobAge=3.
 * wfhType=2 is Naukri's "remote" filter (0 office, 2 remote, 3 hybrid).
 */
export function searchUrl(
  baseUrl: string,
  s: ApplyConfig['searches'][number],
  experienceYears: number,
  jobAgeDays: number,
): string {
  const path = s.location ? `/${slugify(s.keywords)}-jobs-in-${slugify(s.location)}` : `/${slugify(s.keywords)}-jobs`;
  const q = [`k=${encodeURIComponent(s.keywords)}`];
  if (s.location) q.push(`l=${encodeURIComponent(s.location)}`);
  q.push(`experience=${experienceYears}`, `jobAge=${jobAgeDays}`);
  if (s.remote) q.push('wfhType=2');
  return new URL(`${path}?${q.join('&')}`, baseUrl).toString();
}

/** Reads the first page of result cards (div.srp-jobtuple-wrapper[data-job-id]). */
export async function readCards(page: Page): Promise<JobCard[]> {
  return page.locator('div.srp-jobtuple-wrapper[data-job-id]').evaluateAll((els) =>
    els.map((el) => {
      const text = (sel: string): string => (el.querySelector(sel)?.textContent ?? '').trim();
      const a = el.querySelector('a.title') as HTMLAnchorElement | null;
      return {
        id: el.getAttribute('data-job-id') ?? '',
        title: (a?.getAttribute('title') ?? a?.textContent ?? '').trim(),
        company: text('a.comp-name'),
        url: a?.href ?? '',
        experience: text('.expwdth') || text('.exp-wrap'),
        location: text('.locWdth') || text('.loc-wrap'),
      };
    }),
  );
}

/** "5-9 Yrs" → [5, 9]; unparseable → null (kept: Naukri already filtered by experience). */
export function parseExperience(s: string): [number, number] | null {
  const m = /(\d+)\s*-\s*(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const has = (hay: string, needles: string[]): boolean =>
  needles.some((n) => hay.toLowerCase().includes(n.toLowerCase()));

/** Why a card is not worth applying to, or null if it is. */
export function filterReason(card: JobCard, cfg: ApplyConfig): string | null {
  if (!card.id || !card.url) return 'card without id/url';
  if (has(card.title, cfg.excludeTitleWords)) return 'title has an excluded word';
  if (cfg.requireTitleWords.length && !has(card.title, cfg.requireTitleWords)) return 'title lacks a required word';
  if (cfg.excludeCompanies.some((c) => card.company.toLowerCase() === c.toLowerCase())) return 'excluded company';
  const range = parseExperience(card.experience);
  if (range && (cfg.experienceYears < range[0] || cfg.experienceYears > range[1])) {
    return `experience ${card.experience.trim()} doesn't include ${cfg.experienceYears}`;
  }
  return null;
}
