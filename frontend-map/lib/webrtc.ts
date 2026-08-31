import { Camera } from '@/types/camera';

/** Same path segment MediaMTX uses for both LL-HLS and WHEP — prefer the
 * organizer's numeric stream_id, else pull it out of a standalone test
 * camera's hls_url (e.g. ".../stream/xiaomi-camera/index.m3u8" -> "xiaomi-camera"). */
export function getWebRtcStreamPath(camera: Camera): string | null {
  if (camera.stream_id != null && camera.stream_id !== '') return String(camera.stream_id);
  if (camera.hls_url) {
    const match = camera.hls_url.match(/\/stream\/([^/]+)\//);
    if (match) return match[1];
  }
  return null;
}

/** Full WHEP endpoint for a camera, or null if WebRTC isn't configured/
 * viable for it -- same construction CameraLivePlayer uses to decide
 * whether to attempt WebRTC at all, shared here so the connectivity
 * health-check probes the same transport the player actually uses instead
 * of only ever checking HLS. */
export function getWebRtcWhepUrl(camera: Camera, webrtcBase: string | undefined): string | null {
  const streamPath = getWebRtcStreamPath(camera);
  if (!webrtcBase || !streamPath) return null;
  return `${webrtcBase.replace(/\/+$/, '')}/stream/${streamPath}/whep`;
}

export interface WhepSession {
  pc: RTCPeerConnection;
  close: () => void;
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Negotiates a WHEP session against MediaMTX and attaches the incoming
 * track(s) to `video`. This POST/answer flow needs the full ICE candidate
 * set up front (no trickle-ICE follow-up), so it waits briefly for ICE
 * gathering before sending the offer. */
export async function connectWhep(whepUrl: string, video: HTMLVideoElement, signal: AbortSignal): Promise<WhepSession> {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;
  pc.ontrack = (event) => remoteStream.addTrack(event.track);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc, 2000);

  if (signal.aborted) {
    pc.close();
    throw new DOMException('Aborted', 'AbortError');
  }

  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription!.sdp,
    signal,
  });
  if (!res.ok) {
    pc.close();
    throw new Error(`WHEP negotiation failed: HTTP ${res.status}`);
  }

  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  // MediaMTX returns the session's resource URL in Location, used to tear it
  // down cleanly with DELETE. Only present if CORS exposes the header —
  // harmless to skip if it isn't, the session just times out server-side.
  const location = res.headers.get('Location');
  const resourceUrl = location ? new URL(location, whepUrl).toString() : null;

  return {
    pc,
    close: () => {
      pc.close();
      if (resourceUrl) fetch(resourceUrl, { method: 'DELETE' }).catch(() => {});
    },
  };
}
