'use client';

import { useCallback, useMemo, useState } from 'react';

const STORAGE_KEY = 'netra_tile_order';

function loadStoredOrder(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveStoredOrder(order: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Private browsing / quota exceeded -- losing the saved order isn't worth
    // surfacing an error over, tiles just fall back to registry order on the
    // next load.
  }
}

/** `savedOrder` may hold ids that aren't currently visible (filtered out, a
 * camera that was removed) and is missing ids that are visible but were
 * never placed (new camera, or never dragged) -- this reconciles the two
 * into one list covering exactly `visibleIds`, preferring the officer's
 * chosen order and appending anything unplaced at the end. */
function reconcile(savedOrder: string[], visibleIds: string[]): string[] {
  const visibleSet = new Set(visibleIds);
  const placed = savedOrder.filter((id) => visibleSet.has(id));
  const placedSet = new Set(placed);
  const unplaced = visibleIds.filter((id) => !placedSet.has(id));
  return [...placed, ...unplaced];
}

/** Lets an officer drag camera tiles into a preferred order that sticks
 * across refreshes (localStorage-backed, per-browser). `visibleIds` is
 * whatever the current filters/layout would show in registry order -- this
 * hook only ever reorders *within* that set. */
export function useTileOrder(visibleIds: string[]) {
  const [savedOrder, setSavedOrder] = useState<string[]>(() => loadStoredOrder());

  const orderedIds = useMemo(() => reconcile(savedOrder, visibleIds), [savedOrder, visibleIds]);

  const moveTile = useCallback(
    (draggedId: string, targetId: string) => {
      if (draggedId === targetId) return;
      setSavedOrder((prev) => {
        const current = reconcile(prev, visibleIds);
        const withoutDragged = current.filter((id) => id !== draggedId);
        const targetIndex = withoutDragged.indexOf(targetId);
        if (targetIndex === -1) return prev;
        withoutDragged.splice(targetIndex, 0, draggedId);
        saveStoredOrder(withoutDragged);
        return withoutDragged;
      });
    },
    [visibleIds]
  );

  return { orderedIds, moveTile };
}
