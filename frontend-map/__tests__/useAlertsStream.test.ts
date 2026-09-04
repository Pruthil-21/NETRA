import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAlertsStream } from '@/hooks/useAlertsStream';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('useAlertsStream', () => {
  it('opens a WebSocket to /alerts/stream and calls onAlert on message', () => {
    const onAlert = vi.fn();
    renderHook(() => useAlertsStream(onAlert));

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('/alerts/stream?token=');

    ws.onmessage?.({ data: JSON.stringify({ id: 1, plate_number: 'GJ01AB1234' }) });
    expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ plate_number: 'GJ01AB1234' }));
  });
});
