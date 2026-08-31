'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';
import { resolveSightingCamera } from '@/lib/resolveSightingCamera';

const TOAST_LIFETIME_MS = 6000;

interface Toast {
  key: string;
  cameraName: string;
  detectedAt: string;
  confidence: number | null;
  plate: string;
}

/**
 * Fires a toast the moment a sighting first appears in `sightings` --
 * including the very first one for a fresh search, not just ones that
 * arrive later via polling. Overlays the map (not the narrow sidebar) so
 * a new detection is hard to miss while watching the route build out.
 */
export function SightingAlertToasts({
  sightings,
  cameras,
}: {
  sightings: Detection[];
  cameras: Camera[];
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    // A cleared/fresh search (no results yet) starts a new detection
    // sequence -- forget what was already alerted so the next run's
    // first sighting notifies again, even if it reuses the same id.
    if (sightings.length === 0) {
      seenIds.current = new Set();
      return;
    }

    const cameraById = new Map(cameras.map((cam) => [cam.id, cam]));
    const fresh = sightings.filter((s) => !seenIds.current.has(s.id));
    if (fresh.length === 0) return;

    fresh.forEach((s) => seenIds.current.add(s.id));

    const newToasts: Toast[] = fresh.map((s) => {
      const camera = resolveSightingCamera(s, cameraById);
      return {
        key: `${s.id}-${s.detected_at}`,
        cameraName: camera?.name || `Camera #${s.camera_id}`,
        detectedAt: s.detected_at,
        confidence: s.confidence,
        plate: s.plate_number,
      };
    });

    setToasts((prev) => [...prev, ...newToasts]);
    newToasts.forEach((t) => {
      setTimeout(() => {
        setToasts((prev) => prev.filter((existing) => existing.key !== t.key));
      }, TOAST_LIFETIME_MS);
    });
    // cameras only affects display text on future toasts, not which
    // sightings count as "already seen" -- excluded so a registry refresh
    // doesn't retrigger alerts for sightings already shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sightings]);

  if (toasts.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2 pointer-events-none w-72">
      {toasts.map((t) => (
        <div
          key={t.key}
          className="pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded bg-panel/95 border border-signal-red/50 shadow-lg animate-in fade-in slide-in-from-top-2"
        >
          <Radio className="text-signal-red shrink-0 mt-0.5" size={16} />
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-white uppercase tracking-wide">
              Sighting: {t.plate}
            </p>
            <p className="text-[11px] text-slate-300 truncate">{t.cameraName}</p>
            <p className="text-[10px] text-slate-500">
              {new Date(t.detectedAt).toLocaleTimeString()}
              {t.confidence != null && ` · ${(t.confidence * 100).toFixed(0)}% confidence`}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default SightingAlertToasts;
