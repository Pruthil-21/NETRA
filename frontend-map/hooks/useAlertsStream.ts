'use client';

import { useEffect, useRef } from 'react';
import { getToken } from '@/lib/session';
import { WATCHLIST_API_URL } from '@/config/streams';

/** Opens a WebSocket to /alerts/stream and calls onAlert for every pushed
 * alert. Auto-reconnects with backoff on drop/error -- does NOT replace the
 * alerts page's existing 5s poll, which stays as the safety net for
 * anything missed during a reconnect window. */
export function useAlertsStream(onAlert: (alert: unknown) => void): void {
  const onAlertRef = useRef(onAlert);
  // Keeping this update inside its own effect (rather than assigning
  // directly during render) is required by the rules of hooks -- refs may
  // only be written outside of render (an effect, or an event handler).
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempt = 0;

    const wsUrl = WATCHLIST_API_URL.replace(/^http/, 'ws') + `/alerts/stream?token=${encodeURIComponent(token)}`;

    const connect = () => {
      if (cancelled) return;
      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          onAlertRef.current(JSON.parse(event.data));
        } catch {
          // malformed message -- ignore, the poll will still catch the real alert
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
  }, []);
}
