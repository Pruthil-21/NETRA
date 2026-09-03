import React from 'react';
import { Camera } from '../../types/camera';
import MapPopupPreviewPlayer from './MapPopupPreviewPlayer';

interface MapPopupCardProps {
  camera: Camera;
  onInspect: () => void;
  /** True once the marker has been continuously hovered past the hold delay —
   * mounts the live preview and grows the popup to fit it. False for a plain
   * click-open (info only, no decoder spun up for a glance that isn't a hover-hold). */
  isPreviewing: boolean;
  /** Pre-resolved stream URL (or null/no-stream reason) — computed by the caller
   * via lib/stream.ts so this card stays a pure display component. */
  previewSrc: string | null;
}

export const MapPopupCard: React.FC<MapPopupCardProps> = ({ camera, onInspect, isPreviewing, previewSrc }) => {
  const status = camera.connectivity_status || 'offline';
  const isOnline = status.toLowerCase() === 'online';
  const displayLocation = camera.dept || 'Gujarat';

  return (
    <div
      className={`text-slate-100 overflow-hidden transition-[width] duration-300 ease-out [contain:layout] [will-change:width] ${
        isPreviewing ? 'w-[240px]' : 'w-[180px]'
      }`}
    >
      {/* Grows in from the top edge as the preview mounts -- the one motion
          flourish for this feature, matching the LIVE-pulse language already
          used in the drawer's live players rather than inventing a new one.
          [contain:layout] on both this box and its parent above scopes the
          layout recalculation this transition forces (width and
          grid-template-rows are layout-affecting, unlike transform/opacity)
          to just this popup card instead of letting it ripple into the
          surrounding Leaflet-managed DOM -- same visual result, cheaper paint. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out [contain:layout] [will-change:grid-template-rows] ${
          isPreviewing ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="aspect-video w-full border-b border-line">
            {isPreviewing && <MapPopupPreviewPlayer src={previewSrc} />}
          </div>
        </div>
      </div>

      <div className="p-2">
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-xs text-white truncate max-w-[150px]">
            {camera.name || `Camera #${camera.id}`}
          </span>
          <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-signal-green' : 'bg-signal-red'}`} />
        </div>
        <p className="text-[11px] font-mono text-command mb-0.5">{camera.id}</p>
        <p className="text-[11px] text-slate-400 mb-2">{displayLocation}</p>
        <button
          type="button"
          onClick={onInspect}
          className="w-full py-1 px-2 text-[11px] bg-command hover:bg-command-dim text-white rounded font-medium transition"
        >
          Inspect Record
        </button>
      </div>
    </div>
  );
};

export default MapPopupCard;