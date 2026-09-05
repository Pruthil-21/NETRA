'use client';

import { useEffect, useState } from 'react';
import { authHeaders } from '@/lib/apiAuth';

export interface UptimeWindow {
  status: string;
  from: string;
  to: string | null;
  duration_seconds: number;
}

export interface CameraUptimeReport {
  camera_id: number;
  current_status: string;
  windows: UptimeWindow[];
}

const REGISTRY_API_URL = process.env.NEXT_PUBLIC_REGISTRY_API_URL || 'http://localhost:8000';

/** Backs the detail drawer's Runtime panel -- GET /cameras/{id}/uptime, backed by
 * camera_status_history (append-only, one row per real connectivity transition;
 * see backend-registry/app/services/cameras_service.py's get_uptime_windows). Refetches
 * whenever the selected camera changes; doesn't poll on its own since the drawer only
 * needs a fresh read the moment an officer opens it, not a live-ticking log. */
export function useCameraUptime(cameraId: number | null) {
  const [report, setReport] = useState<CameraUptimeReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cameraId === null) {
      setReport(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${REGISTRY_API_URL}/cameras/${cameraId}/uptime`, { headers: authHeaders(), cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
        return res.json();
      })
      .then((data: CameraUptimeReport) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load uptime report');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  return { report, loading, error };
}

/** "2h 14m", "45s", "3d 1h" -- windows can legitimately span seconds (a flapping
 * connection) or days (a camera that's just been reliably up), so the format
 * picks whichever two units matter most instead of a fixed hh:mm:ss shape. */
export function formatDuration(seconds: number): string {
  if (seconds < 1) return '<1s';
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/** "Sep 5, 08:12 -> Sep 5, 10:26" (or "-> now" for the window still open) --
 * formatDuration answers "how long," this answers "when," which matters just
 * as much when an officer is reconstructing what happened around a specific
 * incident time rather than just judging overall reliability. */
export function formatTimeRange(from: string, to: string | null): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return `${fmt(from)} → ${to === null ? 'now' : fmt(to)}`;
}
