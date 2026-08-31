import React from 'react';
import { Camera } from '@/types/camera';
import Badge from '@/components/common/Badge';

interface CameraCardProps {
  camera: Camera;
  isSelected: boolean;
  onSelect: () => void;
}

function CameraCard({ camera, isSelected, onSelect }: CameraCardProps) {
  const isOnline = (camera.connectivity_status || 'offline').toLowerCase() === 'online';

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
      className={`px-3.5 py-3 cursor-pointer transition text-xs border-b border-line/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-command focus-visible:ring-inset ${
        isSelected ? 'bg-command/10 border-l-[3px] border-l-command' : 'hover:bg-panel-raised border-l-[3px] border-l-transparent'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="font-semibold text-slate-200 truncate">{camera.name}</span>
        <Badge status={isOnline ? 'online' : 'offline'} text={isOnline ? 'Live' : 'Down'} />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <span className="font-mono text-command shrink-0">{camera.id}</span>
        <span className="text-line">•</span>
        <span className="truncate">{camera.dept}</span>
      </div>
    </div>
  );
}

export default React.memo(CameraCard);
