'use client';

import { useEffect, useState } from 'react';
import { getToken } from '@/lib/session';
import { REGISTRY_API_URL } from '@/config/streams';
import { fetchRecordingHealthEvents, RecordingHealthEvent } from '@/services/recordingsService';

const MAX_EVENTS = 20;

/** Backs the detail drawer's Recording Health panel -- an initial REST
 * snapshot (fast, local, doesn't depend on the recording service being
 * reachable) followed by a live WebSocket subscription for anything that
 * arrives after (backend-registry's /recordings/health-stream, same
 * district-scoped push pattern as useAlertsStream). Auto-reconnects with
 * backoff on drop/error; a missed event during a reconnect window is
 * recoverable by reselecting the camera (a fresh REST snapshot). */
export function useRecordingHealthEvents(cameraId: number | null) {
  const [events, setEvents] = useState<RecordingHealthEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cameraId === null) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchRecordingHealthEvents(cameraId, MAX_EVENTS)
      .then((result) => {
        if (!cancelled) setEvents(result);
      })
      .catch(() => {
        // Non-fatal -- the panel just stays empty until the live stream
        // below delivers something, or the camera is reselected.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  useEffect(() => {
    if (cameraId === null) return;
    const token = getToken();
    if (!token) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempt = 0;

    const wsUrl = REGISTRY_API_URL.replace(/^http/, 'ws') + `/recordings/health-stream?token=${encodeURIComponent(token)}`;

    const connect = () => {
      if (cancelled) return;
      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as RecordingHealthEvent;
          // The stream is district-scoped server-side, not camera-scoped --
          // an officer's connection sees every camera in their jurisdiction,
          // so this panel (one specific camera) filters client-side.
          if (parsed.camera_id !== cameraId) return;
          setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
        } catch {
          // malformed message -- ignore, the REST snapshot on reselect stays correct
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        attempt += 1;
        setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onopen = () => {
        attempt = 0;
      };
    };

    connect();

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [cameraId]);

  return { events, loading };
}
