'use client';

import React from 'react';
import { X } from 'lucide-react';
import { Camera } from '@/types/camera';
import CameraDetailDrawer from './CameraDetailDrawer';

/** "Properties" from the right-click menu -- the same health/uptime/recording
 * info CameraDetailDrawer already shows, just reachable from any page
 * (Dashboard has no drawer host at all; Archive doesn't either) instead of
 * only Map/Search, which render it as a bottom panel bound to their own
 * selectedCamera state. Modal chrome matches AddCameraModal's. */
export default function CameraDetailModal({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="camera-detail-title"
      onClick={onClose}
    >
      <div
        // CameraDetailDrawer is normally a full page-width bottom bar (Map/
        // Search) -- its internal grid (grid-cols-6 at the sm breakpoint)
        // needs that much real width or its columns overlap instead of
        // wrapping. max-w-3xl was too narrow for that; this is closer to
        // the width it actually renders at elsewhere.
        className="w-full max-w-6xl max-h-[90vh] overflow-y-auto bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <h2 id="camera-detail-title" className="text-sm font-semibold text-white tracking-wide truncate">
            {camera.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-panel-raised shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <CameraDetailDrawer camera={camera} />
      </div>
    </div>
  );
}
