import React from 'react';
import { Camera } from '@/types/camera';
import { getCameraStreamUrl } from '@/lib/stream';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import CameraLivePlayer from './CameraLivePlayer';
import Badge from '@/components/common/Badge';

export default function CameraDetailDrawer({ camera }: { camera: Camera | null }) {
  const { updateCameraConnectivity } = useCameraRegistry();

  if (!camera) {
    return <div className="p-4 text-xs text-slate-500">No camera selected. Pick one from the list or the map.</div>;
  }

  // Preliminary connectivity_status (from the organizer's width>0 signal, or
  // the background health check below) isn't the final word — every camera
  // with a resolvable stream gets a real connection attempt when selected.
  const stream = getCameraStreamUrl(camera);
  const isOnline = (camera.connectivity_status || 'offline').toLowerCase() === 'online';

  return (
    <div className="flex flex-col sm:flex-row bg-panel border-t border-line">
      <div className="w-full sm:w-64 h-36 shrink-0 border-b sm:border-b-0 sm:border-r border-line">
        <CameraLivePlayer
          camera={camera}
          hlsSrc={stream.url}
          hlsUnavailableReason={stream.reason}
          onStatusChange={(status) => updateCameraConnectivity(camera.id, status)}
        />
      </div>
      <div className="flex-1 p-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs">
        <div>
          <p className="font-bold text-white truncate">{camera.name}</p>
          <p className="font-mono text-command">{camera.id}</p>
        </div>
        <div className="flex flex-col gap-1.5 items-start">
          <Badge status={isOnline ? 'online' : 'offline'} text={isOnline ? 'Online' : 'Offline'} />
          <Badge status={camera.health_status} text={camera.health_status} />
        </div>
        <div>
          <p className="text-slate-200">{camera.dept}</p>
          <p className="text-slate-500">{camera.ownership}</p>
        </div>
        <div>
          <p className="text-slate-200">{camera.storage_type} Architecture</p>
          <p className="text-slate-500">{camera.retention_days} Days Archival Policy</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-0.5">RTSP Source</p>
          <code className="text-command font-mono break-all">{camera.rtsp_url || '—'}</code>
        </div>
      </div>
    </div>
  );
}