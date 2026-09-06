'use client';

import { useEffect, useState } from 'react';
import { getCameraHealth, CameraHealthDevice } from '@/services/snmpService';

/** Backs the detail drawer's Device Health panel -- refetches whenever the
 * selected camera changes, same "fresh read on open, no live polling" shape
 * as useCameraUptime. `device` stays null both while nothing's selected and
 * when the monitor has nothing for this camera (see snmpService docstring). */
export function useCameraHealth(cameraId: number | null) {
  const [device, setDevice] = useState<CameraHealthDevice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cameraId === null) {
      setDevice(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCameraHealth(cameraId)
      .then((result) => {
        if (!cancelled) setDevice(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load device health');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  return { device, loading, error };
}
