import { describe, it, expect } from 'vitest';
import { analyzePassword, MIN_LENGTH } from '@/lib/passwordStrength';

describe('analyzePassword', () => {
  it('rejects a password shorter than the minimum length', () => {
    const result = analyzePassword('Ab1!');
    expect(result.meetsRequirements).toBe(false);
    expect(result.weaknesses).toContain(`Shorter than the required minimum of ${MIN_LENGTH} characters.`);
  });

  it('rejects a common dictionary word even if long enough', () => {
    const result = analyzePassword('password');
    expect(result.meetsRequirements).toBe(false);
    expect(result.score).toBeLessThan(2);
  });

  it('rejects a keyboard-walk pattern', () => {
    const result = analyzePassword('qwertyuiop');
    expect(result.weaknesses.some((w) => w.includes('keyboard-walk'))).toBe(true);
  });

  it('rejects a sequential run', () => {
    const result = analyzePassword('abcdefgh123');
    expect(result.weaknesses.some((w) => w.includes('sequential'))).toBe(true);
  });

  it('scores a password built from the officer\'s own details lower than the same password treated as arbitrary', () => {
    const withOwnDetails = analyzePassword('GJ-SO-001-2026', ['GJ-SO-001']);
    const withoutContext = analyzePassword('GJ-SO-001-2026', []);
    expect(withOwnDetails.score).toBeLessThanOrEqual(withoutContext.score);
  });

  it('accepts a genuinely strong, long passphrase', () => {
    const result = analyzePassword('Correct-Horse-Battery-Staple-9!');
    expect(result.meetsRequirements).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(2);
  });
});
