'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Camera } from '@/types/camera';
import MapPopupPreviewPlayer from '@/components/map/MapPopupPreviewPlayer';
import { getCameraStreamUrl } from '@/lib/stream';

interface CameraInfoOverlayProps {
  camera: Camera | null;
  circleName?: string | null;
  onClose: () => void;
  /** Fired when the cursor enters/leaves this overlay's own footprint. The
   * overlay renders `fixed inset-0` over whatever tile/marker the cursor was
   * hovering when it opened -- once open, that source tile/marker's own
   * mouseleave fires (the cursor is now over the overlay, not the tile),
   * which would otherwise run the caller's hover-grace "end" timer and close
   * this overlay right back out, only for hover to restart on the
   * now-revealed tile a moment later (an open/close/reopen flicker loop).
   * Callers use these to track "is the mouse currently over the overlay" and
   * skip that clear while it's true -- see app/page.tsx and app/map/page.tsx. */
  onMouseEnterOverlay?: () => void;
  onMouseLeaveOverlay?: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200 text-right truncate">{value}</dd>
    </div>
  );
}

/** Shared full-info hover preview for both the dashboard grid and the map --
 * one component, one hover behavior everywhere a camera can be hovered.
 * Portal-rendered to document.body so it's never affected by Leaflet's own
 * re-renders (see CameraMap.tsx's marker-ref fix, Task 7) and never clipped
 * by an ancestor's overflow/stacking context. */
export function CameraInfoOverlay({
  camera,
  circleName,
  onClose,
  onMouseEnterOverlay,
  onMouseLeaveOverlay,
}: CameraInfoOverlayProps) {
  if (!camera || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[3000] bg-black/70 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onMouseEnter={onMouseEnterOverlay}
      onMouseLeave={() => {
        onMouseLeaveOverlay?.();
        // The cursor genuinely left the overlay (not just moved onto one of
        // its own children -- React's onMouseLeave, unlike onMouseOut,
        // already ignores those) -- nothing else keeps this open, so close
        // it the same way the tile/marker's own hover-grace timeout would
        // have, had the overlay not been covering it.
        onClose();
      }}
    >
      <div
        className="w-[60vw] h-[60vh] max-w-4xl bg-panel border border-line rounded-lg shadow-2xl flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-1/2 h-full bg-ink">
          <MapPopupPreviewPlayer src={getCameraStreamUrl(camera).url} />
        </div>
        <div className="w-1/2 h-full p-5 overflow-y-auto text-xs">
          <div className="flex items-start justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">{camera.name}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-white">
              <X size={16} />
            </button>
          </div>
          <dl className="space-y-2 text-slate-300">
            <Row label="Camera ID" value={String(camera.id)} />
            <Row label="District" value={camera.dept} />
            <Row label="Area" value={circleName ?? 'Unassigned'} />
            <Row label="Type" value={camera.camera_type} />
            <Row label="Ownership" value={camera.ownership} />
            <Row label="Connectivity" value={camera.connectivity_status} />
            <Row label="Health" value={camera.health_status} />
            <Row label="Storage" value={camera.storage_type} />
            <Row label="Retention" value={`${camera.retention_days} days`} />
          </dl>
          <div className="mt-4 pt-4 border-t border-line">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
              Device health (SNMP)
            </p>
            <p className="text-slate-600 italic">Not yet available for this camera.</p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default CameraInfoOverlay;
