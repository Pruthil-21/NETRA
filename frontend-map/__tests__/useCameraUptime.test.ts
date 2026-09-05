import { describe, it, expect } from 'vitest';
import { formatTimeRange } from '@/hooks/useCameraUptime';

describe('formatTimeRange', () => {
  it('formats a closed window as "from -> to"', () => {
    const result = formatTimeRange('2026-09-05T08:12:00Z', '2026-09-05T10:26:00Z');
    expect(result).toContain('→');
    expect(result).not.toContain('now');
  });

  it('formats a still-open window as "from -> now"', () => {
    const result = formatTimeRange('2026-09-05T08:12:00Z', null);
    expect(result.endsWith('now')).toBe(true);
  });
});
