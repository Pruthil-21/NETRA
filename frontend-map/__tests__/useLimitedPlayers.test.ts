import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useLimitedPlayers } from '@/hooks/useLimitedPlayers';

describe('useLimitedPlayers', () => {
  it('opens players up to the configured limit', () => {
    const { result } = renderHook(() => useLimitedPlayers(2));
    act(() => result.current.openPlayer(1));
    act(() => result.current.openPlayer(2));
    expect(result.current.activeCameraIds.size).toBe(2);
  });

  it('closes the oldest player when opening past the limit', () => {
    const { result } = renderHook(() => useLimitedPlayers(2));
    act(() => result.current.openPlayer(1));
    act(() => result.current.openPlayer(2));
    act(() => result.current.openPlayer(3));

    expect(result.current.activeCameraIds.size).toBe(2);
    expect(result.current.activeCameraIds.has(1)).toBe(false); // oldest evicted
    expect(result.current.activeCameraIds.has(2)).toBe(true);
    expect(result.current.activeCameraIds.has(3)).toBe(true);
  });

  it('closePlayer removes exactly that camera', () => {
    const { result } = renderHook(() => useLimitedPlayers(2));
    act(() => result.current.openPlayer(1));
    act(() => result.current.closePlayer(1));
    expect(result.current.activeCameraIds.has(1)).toBe(false);
  });

  it('opening an already-open camera does not evict anything', () => {
    const { result } = renderHook(() => useLimitedPlayers(2));
    act(() => result.current.openPlayer(1));
    act(() => result.current.openPlayer(2));
    act(() => result.current.openPlayer(1));
    expect(result.current.activeCameraIds.size).toBe(2);
  });
});
