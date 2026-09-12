import { describe, it, expect } from 'vitest';
import { isInScope } from '@/lib/scope';

describe('isInScope', () => {
  it('is always true for a platform-scoped (or unscoped) actor', () => {
    expect(isInScope('platform', null, 'Anand')).toBe(true);
    expect(isInScope(null, null, 'Anand')).toBe(true);
  });

  it('matches a district-scoped actor only against their own district', () => {
    expect(isInScope('district', 'Anand', 'Anand')).toBe(true);
    expect(isInScope('district', 'Anand', 'Ahmedabad')).toBe(false);
  });

  it('is false for a district-scoped actor against a resource with no district at all', () => {
    expect(isInScope('district', 'Anand', null)).toBe(false);
    expect(isInScope('district', 'Anand', undefined)).toBe(false);
  });
});
