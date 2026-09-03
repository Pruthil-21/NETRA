"use client";

import { useEffect, useState } from "react";

/** Ticks once a second so "Xs ago" text stays live without every caller running its
 * own interval -- and flags data as stale once it's older than the poll cadence
 * that's supposed to be refreshing it (a poll that's still "on schedule" just
 * hasn't ticked yet; one that's overdue means something's actually wrong). */
export function useStaleness(
  lastUpdated: Date | null,
  hasError: boolean,
  pollIntervalMs: number
): { isStale: boolean; label: string } {
  // `now` (not a tick counter) so the age math below reads state, not an impure
  // Date.now() call in the render body -- react-hooks/purity flags the latter,
  // and the initializer form of useState only runs once, on mount.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!lastUpdated) return { isStale: hasError, label: hasError ? "never updated" : "syncing…" };

  const ageMs = now - lastUpdated.getTime();
  const ageSec = Math.floor(ageMs / 1000);
  const label =
    ageSec < 5 ? "just now" : ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;

  // A visibly stale label beats a silently wrong one -- once data is older
  // than however often it's supposed to refresh, the tile/header should say
  // so rather than quietly keep showing a snapshot that may no longer be true.
  const isStale = hasError || ageMs > pollIntervalMs * 1.5;

  return { isStale, label: `updated ${label}` };
}
