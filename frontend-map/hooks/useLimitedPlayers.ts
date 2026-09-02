'use client';

import { useCallback, useState } from 'react';

/** Caps how many HLS players can be mounted at once -- the streaming relay
 * can only hold a handful of concurrent decoders reliably (same constraint
 * documented in FeedCard.tsx for the real dashboard). Opening past the cap
 * evicts the oldest-opened camera rather than refusing the new one; closing
 * an evicted/unmounted player's HlsPlayer already destroys its own hls.js
 * instance via useHls's effect cleanup -- this hook only tracks which
 * cameras are currently selected for playback. */
export function useLimitedPlayers(maxConcurrent: number) {
  const [order, setOrder] = useState<number[]>([]);

  const openPlayer = useCallback(
    (cameraId: number) => {
      setOrder((prev) => {
        if (prev.includes(cameraId)) return prev;
        const next = [...prev, cameraId];
        return next.length > maxConcurrent ? next.slice(next.length - maxConcurrent) : next;
      });
    },
    [maxConcurrent]
  );

  const closePlayer = useCallback((cameraId: number) => {
    setOrder((prev) => prev.filter((id) => id !== cameraId));
  }, []);

  return { activeCameraIds: new Set(order), openPlayer, closePlayer };
}
