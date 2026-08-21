'use client';

import React from 'react';
import { Popup } from 'react-leaflet';
import { Camera } from '../../types/camera';
import Badge from '../common/Badge';

export default function MapPopupCard({
  camera,
  onInspect,
}: {
  camera: Camera;
  onInspect: () => void;
}) {
  return (
    <Popup>
      <div className="p-2 space-y-2 min-w-[200px] text-slate-100">
        <div className="flex items-center justify-between border-b border-slate-700 pb-1">
          <span className="font-mono text-xs font-bold text-blue-400">{camera.id}</span>
          <Badge status={camera.connectivity_status} text={camera.connectivity_status} />
        </div>
        <p className="text-xs font-semibold">{camera.name}</p>
        <p className="text-[11px] text-slate-400">{camera.dept}</p>
        <button
          onClick={onInspect}
          className="w-full mt-1 bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium py-1 rounded"
        >
          Inspect Record
        </button>
      </div>
    </Popup>
  );
}