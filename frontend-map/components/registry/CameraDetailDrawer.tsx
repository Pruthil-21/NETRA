import React, { useEffect, useMemo, useState } from 'react';
import { Activity, History, Radio, VideoOff } from 'lucide-react';
import { Camera } from '@/types/camera';
import { getCameraStreamUrl } from '@/lib/stream';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { useCameraUptime, formatDuration, formatTimeRange } from '@/hooks/useCameraUptime';
import { useCameraHealth } from '@/hooks/useCameraHealth';
import { usePermissions } from '@/hooks/usePermissions';
import { circlesService, Circle } from '@/services/circlesService';
import { cameraService } from '@/services/cameraService';
import CameraLivePlayer from './CameraLivePlayer';
import Badge from '@/components/common/Badge';

export default function CameraDetailDrawer({ camera }: { camera: Camera | null }) {
  const { updateCameraConnectivity, applyCameraCircleAssignment } = useCameraRegistry();
  const { report: uptime, loading: uptimeLoading, error: uptimeError } = useCameraUptime(camera?.id ?? null);
  const { device: health, loading: healthLoading } = useCameraHealth(camera?.id ?? null);
  const { has } = usePermissions();
  const canManageCameras = has('manage_cameras');

  // Circle assignment -- the one write path for a REAL registry camera's
  // circle_id (see services/cameraService.ts's updateCameraCircle). Fetched
  // once here rather than lifted to a shared context: this is the only place
  // in the app that needs the full circle list alongside a single camera to
  // edit against.
  const [circles, setCircles] = useState<Circle[]>([]);
  const [circleUpdatePending, setCircleUpdatePending] = useState(false);
  const [circleError, setCircleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    circlesService
      .listCircles()
      .then((data) => {
        if (!cancelled) setCircles(data);
      })
      .catch(() => {
        // Non-fatal -- the control just shows no circle options until this succeeds/retries.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only this camera's own district's circles are valid choices -- matches
  // the backend's own cross-district guard (circle.district must equal
  // camera.dept). Unlike AddCameraModal's manual-camera circle picker (which
  // has no real camera.dept to filter by), this control always has one.
  const districtCircles = useMemo(
    () => (camera ? circles.filter((c) => c.district === camera.dept) : []),
    [circles, camera]
  );
  const currentCircleName = useMemo(
    () => circles.find((c) => c.id === camera?.circle_id)?.name ?? 'Unassigned',
    [circles, camera]
  );

  const handleCircleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!camera) return;
    const raw = e.target.value;
    const newCircleId = raw === '' ? null : Number(raw);
    setCircleError(null);
    setCircleUpdatePending(true);
    try {
      await cameraService.updateCameraCircle(camera.id, newCircleId);
      applyCameraCircleAssignment(camera.id, newCircleId);
    } catch (err) {
      setCircleError(err instanceof Error ? err.message : 'Failed to update circle');
    } finally {
      setCircleUpdatePending(false);
    }
  };

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
          key={camera.id}
          camera={camera}
          hlsSrc={stream.url}
          hlsUnavailableReason={stream.reason}
          onStatusChange={(status) => updateCameraConnectivity(camera.id, status)}
        />
      </div>
      <div className="flex-1 min-w-0 flex flex-col sm:flex-row">
        <div className="p-4 grid grid-cols-2 sm:grid-cols-6 gap-4 text-xs flex-1">
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
            <div className="mt-1.5">
              <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-0.5">Circle</p>
              {canManageCameras ? (
                <select
                  aria-label="Circle"
                  value={camera.circle_id ?? ''}
                  onChange={handleCircleChange}
                  disabled={circleUpdatePending}
                  className="w-full bg-ink border border-line rounded px-1.5 py-1 text-[11px] text-slate-100 focus:outline-none focus:ring-1 focus:ring-command focus:border-command"
                >
                  <option value="">Unassigned</option>
                  {districtCircles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-slate-200">{currentCircleName}</p>
              )}
              {circleError && <p className="text-[10px] text-signal-red mt-1">{circleError}</p>}
            </div>
          </div>
          <div>
            <p className="text-slate-200">{camera.storage_type} Architecture</p>
            <p className="text-slate-500">{camera.retention_days} Days Archival Policy</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-0.5">RTSP Source</p>
            <code className="text-command font-mono break-all">{camera.rtsp_url || '—'}</code>
          </div>
          <div>
            <p className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-0.5">
              <Activity size={10} />
              Device Health
            </p>
            {healthLoading && <p className="text-slate-600 italic">Checking…</p>}
            {!healthLoading && !health && <p className="text-slate-600 italic">Not available</p>}
            {health && (
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono">
                <span className="text-slate-500">CPU</span>
                <span className="text-slate-200">{health.metrics ? `${health.metrics.cpu_percent}%` : '—'}</span>
                <span className="text-slate-500">Mem</span>
                <span className="text-slate-200">{health.metrics ? `${health.metrics.memory_percent}%` : '—'}</span>
                <span className="text-slate-500">Net</span>
                <span className="text-slate-200">{health.metrics ? `${health.metrics.network_mbps} Mbps` : '—'}</span>
                <span className="text-slate-500">Temp</span>
                <span className="text-slate-200">{health.metrics ? `${health.metrics.temperature_celsius}°C` : '—'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Runtime log -- GET /cameras/{id}/uptime, backed by camera_status_history
            (append-only, one row per real connectivity transition). Most-recent
            window first, since "what's it doing right now / just now" is what an
            officer checking a camera's reliability actually wants first. */}
        <div className="w-full sm:w-64 shrink-0 border-t sm:border-t-0 sm:border-l border-line p-3 flex flex-col min-h-0">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-2 shrink-0">
            <History size={11} />
            Runtime
          </p>
          {uptimeLoading && <p className="text-[11px] text-slate-500">Loading history…</p>}
          {uptimeError && <p className="text-[11px] text-signal-red">{uptimeError}</p>}
          {uptime && uptime.windows.length === 0 && (
            <p className="text-[11px] text-slate-500">No status changes recorded yet.</p>
          )}
          {uptime && uptime.windows.length > 0 && (
            <div className="flex flex-col gap-1.5 overflow-y-auto max-h-32 pr-1">
              {[...uptime.windows]
                .reverse()
                .map((w, i) => {
                  const online = w.status.toLowerCase() === 'online';
                  return (
                    <div key={i} className="flex flex-col gap-0.5 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        {online ? (
                          <Radio size={10} className="text-signal-green shrink-0" />
                        ) : (
                          <VideoOff size={10} className="text-signal-red shrink-0" />
                        )}
                        <span className={online ? 'text-signal-green' : 'text-signal-red'}>
                          {w.status}
                        </span>
                        <span className="text-slate-500 font-mono ml-auto">
                          {formatDuration(w.duration_seconds)}
                          {w.to === null && ' (ongoing)'}
                        </span>
                      </div>
                      <span className="text-slate-600 font-mono pl-[15px]">
                        {formatTimeRange(w.from, w.to)}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}