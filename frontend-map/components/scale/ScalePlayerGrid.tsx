'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { ScaleCamera } from '@/types/scaleCamera';

const HlsPlayer = dynamic(() => import('@/components/player/HlsPlayer').then((m) => m.HlsPlayer), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-black" />,
});

interface ScalePlayerGridProps {
  cameras: ScaleCamera[];
  onClose: (cameraId: number) => void;
}

/** A dedicated component (not inlined into the page) specifically so it can
 * be unit-tested directly with a real camera list, instead of driving the
 * whole page's click-flow just to get a panel open in a test. */
export function ScalePlayerGrid({ cameras, onClose }: ScalePlayerGridProps) {
  if (cameras.length === 0) return null;

  return (
    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cameras.map((camera) => (
        <div key={camera.id} className="relative aspect-video bg-black rounded-lg overflow-hidden border border-line">
          <button
            onClick={() => onClose(camera.id)}
            aria-label={`Close player for ${camera.name}`}
            className="absolute top-1 right-1 z-10 p-1 rounded bg-black/60 text-slate-300 hover:text-white"
          >
            <X size={12} />
          </button>
          {/* The backend now enforces is_synthetic=true for every row
              scaleCameraService's include_synthetic=true calls return (see
              cameras_service.list_cameras_page), so every panel on this page
              should always be synthetic in practice -- but this check is
              defense-in-depth, not the sole enforcement, so the badge stays
              tied to the camera's actual flag rather than being unconditional. */}
          {camera.is_synthetic && (
            <span className="absolute top-1 left-1 z-10 text-[8px] uppercase font-bold px-1.5 py-0.5 rounded bg-black/60 text-amber-400">
              Synthetic
            </span>
          )}
          {camera.hls_url ? (
            <HlsPlayer src={camera.hls_url} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-600">
              No live stream provisioned
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
