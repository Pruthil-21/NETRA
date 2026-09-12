'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { Camera } from '@/types/camera';
import { LayerWindowMode } from '@/types/filters';
import { fetchDensity } from '@/services/densityService';
import { metersToPixelRadius } from '@/lib/coverageMath';
import { DENSITY_MIN_RADIUS_PX, DENSITY_RADIUS_METERS, densityColorForRatio } from '@/lib/densityMath';

/** Reported after every fetch attempt (including each live-mode poll) so
 * the filter panel can show *why* the layer is empty -- a permission
 * error, a network failure, or a genuinely quiet window are three very
 * different things an officer needs to tell apart, not one silent blank
 * map. */
export interface DensityLoadStatus {
  loading: boolean;
  error: string | null;
  /** Cameras with at least one detection in the current window --
   * distinguishes "loaded fine, nothing happening right now" from a
   * failed fetch even when both render zero heat blobs. */
  pointCount: number;
}

interface DensityCanvasLayerProps {
  cameras: Camera[];
  mode: LayerWindowMode;
  windowMinutes: number;
  hour: number;
  onStatusChange?: (status: DensityLoadStatus) => void;
}

// How often the live rolling window re-fetches counts. Hour mode never
// polls -- a past hour's bucket doesn't change while the scrubber sits on
// it, so a fetch per hour selection is the only refresh it needs.
const LIVE_POLL_MS = 15000;

/** Paints a relative "how busy is this camera right now" heat blob per
 * camera with at least one detection in the current window -- green for
 * quiet, through amber, to red for the busiest camera currently on
 * screen. Deliberately relative (normalized against the current view's own
 * max count, see lib/densityMath.ts) rather than fixed thresholds: absolute
 * detection volume varies enormously camera-to-camera, so a fixed scale
 * would either wash out every quiet corridor or blow out every busy one.
 *
 * Shares CoverageCanvasLayer's exact pane/zoomanim scaffolding (see that
 * file's docstring for why: a dedicated Leaflet pane for free panning, and
 * the `zoomanim` event for the same reason ImageOverlay/GridLayer hook it --
 * so this canvas visually tracks Leaflet's animated zoom instead of
 * sitting frozen or flickering). Only the draw step itself differs: soft
 * radial-gradient blobs instead of a hard-edged state fill + reach circles. */
export function DensityCanvasLayer({ cameras, mode, windowMinutes, hour, onStatusChange }: DensityCanvasLayerProps) {
  const map = useMap();
  const [counts, setCounts] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      onStatusChange?.({ loading: true, error: null, pointCount: 0 });
      try {
        const points = await fetchDensity(
          mode === 'live' ? { mode: 'live', windowMinutes } : { mode: 'hour', hour }
        );
        if (cancelled) return;
        setCounts(new Map(points.map((p) => [p.camera_id, p.count])));
        onStatusChange?.({ loading: false, error: null, pointCount: points.length });
      } catch (err) {
        if (cancelled) return;
        // Surfaced to the filter panel rather than swallowed -- a
        // permission error (no view_analytics) or a network failure looks
        // identical to "quiet window" otherwise, which is exactly the kind
        // of silent failure an officer can't diagnose from the map alone.
        setCounts(new Map());
        onStatusChange?.({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load density data',
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

  const camerasWithCounts = useMemo(
    () =>
      cameras
        .filter((cam) => cam.long != null && (counts.get(cam.id) ?? 0) > 0)
        .map((cam) => ({ cam, count: counts.get(cam.id) ?? 0 })),
    [cameras, counts]
  );

  const maxCount = useMemo(
    () => camerasWithCounts.reduce((max, { count }) => Math.max(max, count), 0),
    [camerasWithCounts]
  );

  useEffect(() => {
    const pane = map.getPane('density') ?? map.createPane('density');
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

      const zoom = map.getZoom();
      const viewBounds = map.getBounds().pad(0.5);

      for (const { cam, count } of camerasWithCounts) {
        const long = cam.long ?? 0;
        if (!viewBounds.contains(L.latLng(cam.lat, long))) continue;

        const point = map.latLngToContainerPoint([cam.lat, long]);
        const radiusPx = Math.max(
          metersToPixelRadius(cam.lat, zoom, DENSITY_RADIUS_METERS),
          DENSITY_MIN_RADIUS_PX
        );
        const ratio = maxCount > 0 ? count / maxCount : 0;
        const color = densityColorForRatio(ratio);

        // Soft radial blob (opaque center fading to transparent edge)
        // rather than a hard-edged fill -- overlapping blobs read as a
        // continuous heat region instead of a field of distinct dots, and
        // a camera with only a little activity still shows faintly rather
        // than painting as solidly as the busiest one on screen. Alpha
        // floor raised from 0.25 to 0.4 so even the quietest camera on
        // screen has a solid-looking core, not just a wisp.
        const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radiusPx);
        const alpha = 0.4 + 0.5 * ratio;
        gradient.addColorStop(0, `${color.replace('rgb', 'rgba').replace(')', `, ${alpha})`)}`);
        gradient.addColorStop(1, `${color.replace('rgb', 'rgba').replace(')', ', 0)')}`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();

        // A defined edge on top of the fade -- against satellite imagery
        // (dark water, light rooftops, everything in between) a pure soft
        // fade blends into whatever's underneath; a thin solid ring gives
        // every blob a boundary regardless of basemap color.
        ctx.strokeStyle = `${color.replace('rgb', 'rgba').replace(')', ', 0.85)')}`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
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
  }, [map, camerasWithCounts, maxCount]);

  return null;
}

export default DensityCanvasLayer;
