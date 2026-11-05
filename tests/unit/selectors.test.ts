import { describe, expect, it } from 'vitest';
import { lastUpdatedRegex, uploadedOnRegex } from '../../src/selectors.js';

const nov5 = new Date(2026, 10, 5, 10, 0);
const nov15 = new Date(2026, 10, 15, 10, 0);
const nov1 = new Date(2026, 10, 1, 10, 0);

describe('Naukri date matching', () => {
  it('matches the resume card format "Uploaded on Nov 05, 2026"', () => {
    const re = uploadedOnRegex(nov5);
    for (const ok of ['Uploaded on Nov 05, 2026', 'Uploaded on Nov 5, 2026', 'Uploaded on: November 5, 2026', 'Uploaded on Today']) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ['Uploaded on Nov 15, 2026', 'Uploaded on Oct 05, 2026', 'Uploaded on Nov 05, 2025', 'Uploaded on Nov 51, 2026']) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it('matches the top card format "Profile last updated - 05Nov, 2026"', () => {
    const re = lastUpdatedRegex(nov5);
    for (const ok of ['Profile last updated - 05Nov, 2026', 'Profile last updated - 5Nov, 2026', 'Profile last updated - 05 Nov 2026', 'Profile last updated - Today']) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ['Profile last updated - 15Nov, 2026', 'Profile last updated - 05Oct, 2026', 'Profile last updated - 25Nov, 2026']) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it('does not confuse single and double digit days', () => {
    expect(lastUpdatedRegex(nov1).test('Profile last updated - 11Nov, 2026')).toBe(false);
    expect(lastUpdatedRegex(nov1).test('Profile last updated - 01Nov, 2026')).toBe(true);
    expect(uploadedOnRegex(nov1).test('Uploaded on Nov 12, 2026')).toBe(false);
    expect(uploadedOnRegex(nov15).test('Uploaded on Nov 15, 2026')).toBe(true);
  });
});
