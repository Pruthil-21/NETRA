'use client';

import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { Camera } from '@/types/camera';
import { LayerWindowMode } from '@/types/filters';
import { fetchFlows, CorridorFlow } from '@/services/flowService';
import { densityColorForRatio } from '@/lib/densityMath';
import { flowWidthForRatio } from '@/lib/flowMath';

/** Reported after every fetch attempt (including each live-mode poll) --
 * see DensityCanvasLayer's identical DensityLoadStatus for why this is a
 * separate visible state rather than a silent catch. */
export interface FlowLoadStatus {
  loading: boolean;
  error: string | null;
  /** Corridors actually drawable (both endpoints resolved to a known
   * camera position) -- distinguishes "loaded fine, no corridors yet"
   * from a failed fetch even when both render nothing. */
  pointCount: number;
}

interface FlowCanvasLayerProps {
  cameras: Camera[];
  mode: LayerWindowMode;
  windowMinutes: number;
  hour: number;
  onStatusChange?: (status: FlowLoadStatus) => void;
}

const LIVE_POLL_MS = 15000;

/** Paints camera-to-camera traffic corridors as weighted, color-coded
 * lines: thicker for more transitions between that pair in the current
 * window, colored from green (fast/free-flowing) through amber to red
 * (slow/congested) by average inferred speed -- reusing
 * densityColorForRatio's gradient with an inverted ratio (congestion,
 * not busy-ness). One layer carries both signals (volume via width, speed
 * via color) rather than two separate map layers, since both derive from
 * the exact same camera-to-camera transition data (see backend-watchlist's
 * GET /detections/flows).
 *
 * Shares CoverageCanvasLayer/DensityCanvasLayer's exact pane/zoomanim
 * scaffolding -- see CoverageCanvasLayer's docstring for why a dedicated
 * Leaflet pane and the zoomanim event are both needed for this canvas to
 * track panning and animated zoom correctly. */
export function FlowCanvasLayer({ cameras, mode, windowMinutes, hour, onStatusChange }: FlowCanvasLayerProps) {
  const map = useMap();
  const [flows, setFlows] = useState<CorridorFlow[]>([]);

  const cameraById = useMemo(() => {
    const byId = new Map<number, Camera>();
    for (const cam of cameras) byId.set(cam.id, cam);
    return byId;
  }, [cameras]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      onStatusChange?.({ loading: true, error: null, pointCount: 0 });
      try {
        const results = await fetchFlows(mode === 'live' ? { mode: 'live', windowMinutes } : { mode: 'hour', hour });
        if (cancelled) return;
        setFlows(results);
        onStatusChange?.({ loading: false, error: null, pointCount: results.length });
      } catch (err) {
        if (cancelled) return;
        setFlows([]);
        onStatusChange?.({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load flow data',
          pointCount: 0,
        });
      }
    };

    load();
    if (mode !== 'live') return () => {
      cancelled = true;
    };
    const interval = setInterval(load, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // onStatusChange is expected to be a stable setState function (see
    // app/map/page.tsx) -- included here rather than ref-captured since a
    // stable identity means this never causes an extra fetch cycle.
  }, [mode, windowMinutes, hour, onStatusChange]);

  const drawableFlows = useMemo(
    () =>
      flows
        .map((flow) => ({
          flow,
          from: cameraById.get(flow.from_camera_id),
          to: cameraById.get(flow.to_camera_id),
        }))
        .filter(
          (entry): entry is { flow: CorridorFlow; from: Camera; to: Camera } =>
            entry.from != null && entry.from.long != null && entry.to != null && entry.to.long != null
        ),
    [flows, cameraById]
  );

  const maxTransitions = useMemo(
    () => drawableFlows.reduce((max, { flow }) => Math.max(max, flow.transitions), 0),
    [drawableFlows]
  );
  const maxSpeed = useMemo(
    () => drawableFlows.reduce((max, { flow }) => Math.max(max, flow.avg_speed_kmh ?? 0), 0),
    [drawableFlows]
  );

  useEffect(() => {
    const pane = map.getPane('flow') ?? map.createPane('flow');
    pane.style.zIndex = '450';
    pane.style.pointerEvents = 'none';

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.transformOrigin = '0 0';
    pane.appendChild(canvas);

    let renderedBounds: L.LatLngBounds | null = null;

    const reset = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);

      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);

      const viewBounds = map.getBounds().pad(0.5);
      ctx.lineCap = 'round';

      for (const { flow, from, to } of drawableFlows) {
        const fromLatLng = L.latLng(from.lat, from.long ?? 0);
        const toLatLng = L.latLng(to.lat, to.long ?? 0);
        if (!viewBounds.contains(fromLatLng) && !viewBounds.contains(toLatLng)) continue;

        const fromPoint = map.latLngToContainerPoint(fromLatLng);
        const toPoint = map.latLngToContainerPoint(toLatLng);

        const volumeRatio = maxTransitions > 0 ? flow.transitions / maxTransitions : 0;
        // No speed data for this pair reads as neutral (amber) rather than
        // being treated as either extreme -- it's an unknown, not a claim
        // the corridor is fast or slow.
        const congestionRatio =
          flow.avg_speed_kmh != null && maxSpeed > 0 ? 1 - flow.avg_speed_kmh / maxSpeed : 0.5;

        ctx.strokeStyle = densityColorForRatio(congestionRatio);
        ctx.lineWidth = flowWidthForRatio(volumeRatio);
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(fromPoint.x, fromPoint.y);
        ctx.lineTo(toPoint.x, toPoint.y);
        ctx.stroke();
      }

      renderedBounds = map.getBounds();
    };

    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      if (!renderedBounds) return;
      const scale = map.getZoomScale(e.zoom, map.getZoom());
      const newBounds = (
        map as unknown as {
          _latLngBoundsToNewLayerBounds: (b: L.LatLngBounds, z: number, c: L.LatLng) => L.Bounds;
        }
      )._latLngBoundsToNewLayerBounds(renderedBounds, e.zoom, e.center);
      if (!newBounds.min) return;
      L.DomUtil.setTransform(canvas, newBounds.min, scale);
    };

    reset();
    map.on('moveend zoomend resize', reset);
    map.on('zoomanim', onZoomAnim);
    return () => {
      map.off('moveend zoomend resize', reset);
      map.off('zoomanim', onZoomAnim);
      pane.removeChild(canvas);
    };
  }, [map, drawableFlows, maxTransitions, maxSpeed]);

  return null;
}

export default FlowCanvasLayer;
