import React from 'react';
import { Camera } from '../../types/camera';

interface MapPopupCardProps {
  camera: Camera;
  onInspect: () => void;
}

export const MapPopupCard: React.FC<MapPopupCardProps> = ({ camera, onInspect }) => {
  const status = camera.connectivity_status || 'offline';
  const isOnline = status.toLowerCase() === 'online';
  const displayLocation = camera.dept || 'Gujarat';

  return (
    <div className="p-2 min-w-[180px] text-slate-100">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-xs text-white truncate max-w-[120px]">
          {camera.name || `Camera #${camera.id}`}
        </span>
        <span
          className={`w-2 h-2 rounded-full ${
            isOnline ? 'bg-signal-green' : 'bg-signal-red'
          }`}
        />
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
  );
};

export default MapPopupCard;