import React from 'react';
import { Camera } from '@/types/camera';

export default function CameraDetailDrawer({ camera }: { camera: Camera | null }) {
  if (!camera) {
    return <div className="p-4 text-xs text-slate-500">No camera selected.</div>;
  }

  return (
    <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs bg-slate-900 border-t border-slate-800">
      <div>
        <p className="font-bold text-white">{camera.name}</p>
        <p className="font-mono text-blue-400">{camera.id}</p>
      </div>
      <div>
        <p className="text-slate-200">{camera.dept}</p>
        <p className="text-slate-400">{camera.ownership}</p>
      </div>
      <div>
        <p className="text-slate-200">{camera.storage_type} Architecture</p>
        <p className="text-slate-400">{camera.retention_days} Days Archival Policy</p>
      </div>
      <div>
        <code className="text-blue-400 font-mono">{camera.rtsp_url}</code>
      </div>
    </div>
  );
}