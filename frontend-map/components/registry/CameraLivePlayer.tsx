'use client';

import React, { useEffect, useState } from 'react';
import { Camera, ConnectivityStatus } from '@/types/camera';
import type { StreamUnavailableReason } from '@/lib/stream';
import { getWebRtcStreamPath } from '@/lib/webrtc';
import WebRTCPlayer from './WebRTCPlayer';
import LiveFeedPlayer from './LiveFeedPlayer';

// Only the currently-selected camera (CameraDetailDrawer) gets a live player
// at all, so "connect on select, close on deselect/switch" is just this
// component's normal mount/unmount lifecycle — no extra wiring needed.
export default function CameraLivePlayer({
  camera,
  hlsSrc,
  hlsUnavailableReason,
  onStatusChange,
}: {
  camera: Camera;
  hlsSrc: string | null;
  hlsUnavailableReason?: StreamUnavailableReason;
  onStatusChange?: (status: ConnectivityStatus) => void;
}) {
  const webrtcBase = process.env.NEXT_PUBLIC_MEDIAMTX_WEBRTC_URL;
  const streamPath = getWebRtcStreamPath(camera);
  const [webrtcFailed, setWebrtcFailed] = useState(false);

  // A different camera got selected — give WebRTC a fresh shot rather than
  // sticking with whatever the previous camera's connection decided.
  useEffect(() => {
    setWebrtcFailed(false);
  }, [camera.id]);

  const canTryWebRtc = Boolean(webrtcBase && streamPath) && !webrtcFailed;

  if (canTryWebRtc) {
    return (
      <WebRTCPlayer
        key={camera.id}
        whepUrl={`${webrtcBase!.replace(/\/+$/, '')}/stream/${streamPath}/whep`}
        preliminaryStatus={camera.connectivity_status}
        onStatusChange={onStatusChange}
        onFatalError={() => setWebrtcFailed(true)}
      />
    );
  }

  return (
    <LiveFeedPlayer
      key={camera.id}
      src={hlsSrc}
      unavailableReason={hlsUnavailableReason}
      preliminaryStatus={camera.connectivity_status}
      onStatusChange={onStatusChange}
    />
  );
}
