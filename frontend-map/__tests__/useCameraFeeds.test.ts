import { describe, it, expect } from 'vitest';
import { resolveStatus } from '@/hooks/useCameraFeeds';

// connectivity_status/health_status are decided entirely server-side now
// (backend-registry's own periodic sweep) -- resolveStatus is a direct
// mapping of that already-authoritative state, not a pre-probe guess a
// client-side reachability check used to override (see this file's own
// git history / useCameraFeeds.ts's module comment).
describe('resolveStatus', () => {
  it('maps connectivity_status "online" straight to ONLINE', () => {
    expect(resolveStatus('online', 'operational')).toBe('ONLINE');
  });

  it('maps connectivity_status "offline" straight to OFFLINE', () => {
    expect(resolveStatus('offline', 'operational')).toBe('OFFLINE');
  });

  it('health_status "degraded" overrides an online connectivity_status', () => {
    expect(resolveStatus('online', 'degraded')).toBe('DEGRADED');
  });

  it('health_status "down" overrides an online connectivity_status', () => {
    expect(resolveStatus('online', 'down')).toBe('DEGRADED');
  });

  it('falls back to UNKNOWN for an unrecognized connectivity_status', () => {
    expect(resolveStatus('unknown', 'operational')).toBe('UNKNOWN');
  });

  it('treats a blank connectivity_status as UNKNOWN, not OFFLINE', () => {
    expect(resolveStatus('', '')).toBe('UNKNOWN');
  });
});
