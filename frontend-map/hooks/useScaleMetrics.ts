'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { onScaleApiRequest } from '@/services/scaleCameraService';

interface Interaction {
  label: string;
  durationMs: number;
}

/** Lightweight, always-on metrics for the scale demo -- no new dependency,
 * just performance.now() markers and the (Chrome-only, gracefully absent
 * elsewhere) performance.memory API. Read by ScaleMetricsPanel for an
 * on-page readout judges/officers can see directly.
 *
 * apiRequestCount subscribes to onScaleApiRequest so every real fetch
 * scaleCameraService makes is counted automatically -- recordApiRequest()
 * is for the one fetch on this page that doesn't go through that service
 * (the /health check). initialLoadMs resolves on the FIRST request from
 * either source, which is "time until real data started arriving," not a
 * single requestAnimationFrame tick after mount. */
export function useScaleMetrics() {
  const [initialLoadMs, setInitialLoadMs] = useState<number | null>(null);
  const [apiRequestCount, setApiRequestCount] = useState(0);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const mountTime = useRef(performance.now());
  const firstRequestRecorded = useRef(false);

  const markFirstRequestIfNeeded = useCallback(() => {
    if (!firstRequestRecorded.current) {
      firstRequestRecorded.current = true;
      setInitialLoadMs(performance.now() - mountTime.current);
    }
  }, []);

  const recordApiRequest = useCallback(() => {
    setApiRequestCount((prev) => prev + 1);
    markFirstRequestIfNeeded();
  }, [markFirstRequestIfNeeded]);

  useEffect(() => {
    return onScaleApiRequest(() => {
      setApiRequestCount((prev) => prev + 1);
      markFirstRequestIfNeeded();
    });
  }, [markFirstRequestIfNeeded]);

  const recordInteraction = useCallback((label: string, durationMs: number) => {
    setInteractions((prev) => [...prev, { label, durationMs }]);
  }, []);

  const memoryMb = (() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory ? Math.round(perf.memory.usedJSHeapSize / (1024 * 1024)) : null;
  })();

  return { initialLoadMs, apiRequestCount, memoryMb, recordApiRequest, recordInteraction, interactions };
}
