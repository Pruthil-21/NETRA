import React from 'react';
import { Camera } from '@/types/camera';
import { getHlsStreamUrl } from '@/lib/stream';
import LiveFeedPlayer from './LiveFeedPlayer';

export default function CameraDetailDrawer({ camera }: { camera: Camera | null }) {
  if (!camera) {
    return <div className="p-4 text-xs text-slate-500">No camera selected.</div>;
  }

  // Preliminary connectivity_status (from the organizer's width>0 signal) is
  // not definitive, so every camera with a stream_id gets a real connection
  // attempt — actual HLS playback success/failure is the final status.
  const stream = getHlsStreamUrl(camera.stream_id);

  return (
    <div className="flex flex-col sm:flex-row bg-slate-900 border-t border-slate-800">
      <div className="w-full sm:w-64 h-36 shrink-0 border-b sm:border-b-0 sm:border-r border-slate-800">
        <LiveFeedPlayer
          src={stream.url}
          unavailableReason={stream.reason}
          preliminaryStatus={camera.connectivity_status}
        />
      </div>
      <div className="flex-1 p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
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
    </div>
  );
}