import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTileOrder } from '@/hooks/useTileOrder';

describe('useTileOrder', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('with nothing saved, returns the visible ids in their given order', () => {
    const { result } = renderHook(() => useTileOrder(['1', '2', '3']));
    expect(result.current.orderedIds).toEqual(['1', '2', '3']);
  });

  it('moveTile reorders and persists across a remount', () => {
    const { result, rerender } = renderHook(({ ids }) => useTileOrder(ids), {
      initialProps: { ids: ['1', '2', '3'] },
    });

    act(() => result.current.moveTile('3', '1'));
    expect(result.current.orderedIds).toEqual(['3', '1', '2']);

    rerender({ ids: ['1', '2', '3'] });
    expect(result.current.orderedIds).toEqual(['3', '1', '2']);

    // A fresh hook instance (simulating a page reload) reads the same persisted order.
    const { result: afterReload } = renderHook(() => useTileOrder(['1', '2', '3']));
    expect(afterReload.current.orderedIds).toEqual(['3', '1', '2']);
  });

  it('drops a previously-placed id once it is no longer visible', () => {
    const { result, rerender } = renderHook(({ ids }) => useTileOrder(ids), {
      initialProps: { ids: ['1', '2', '3'] },
    });
    act(() => result.current.moveTile('3', '1'));
    expect(result.current.orderedIds).toEqual(['3', '1', '2']);

    rerender({ ids: ['1', '2'] });
    expect(result.current.orderedIds).toEqual(['1', '2']);
  });

  it('appends a newly-visible id after the placed ones', () => {
    const { result, rerender } = renderHook(({ ids }) => useTileOrder(ids), {
      initialProps: { ids: ['1', '2'] },
    });
    act(() => result.current.moveTile('2', '1'));
    expect(result.current.orderedIds).toEqual(['2', '1']);

    rerender({ ids: ['1', '2', '3'] });
    expect(result.current.orderedIds).toEqual(['2', '1', '3']);
  });

  it('moving a tile onto itself is a no-op', () => {
    const { result } = renderHook(() => useTileOrder(['1', '2', '3']));
    act(() => result.current.moveTile('1', '1'));
    expect(result.current.orderedIds).toEqual(['1', '2', '3']);
  });
});
