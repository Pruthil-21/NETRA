import React from 'react';
import { Camera } from '@/types/camera';

interface CameraCardProps {
  camera: Camera;
  isSelected: boolean;
  onSelect: () => void;
}

export default function CameraCard({ camera, isSelected, onSelect }: CameraCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`p-3.5 cursor-pointer transition text-xs border-b border-slate-800/60 ${
        isSelected ? 'bg-blue-950/40 border-l-4 border-l-blue-500' : 'hover:bg-slate-800/40'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-slate-200">{camera.name}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span className="font-mono text-blue-400">{camera.id}</span>
        <span>•</span>
        <span>{camera.dept}</span>
      </div>
    </div>
  );
}