'use client';

import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { Camera } from '@/types/camera';
import { GUJARAT_BOUNDARY_RINGS } from '@/lib/gujaratBoundary';
import {
  COVERAGE_COLORS,
  COVERAGE_RADIUS_METERS,
  coverageStatusForCamera,
  isWithinGujarat,
  metersToPixelRadius,
} from '@/lib/coverageMath';

interface CoverageCanvasLayerProps {
  cameras: Camera[];
}

/** Paints Gujarat's whole coverage picture in one always-on view: the
 * state's actual boundary (see lib/gujaratBoundary.ts -- a real, simplified
 * outline, not a bounding rectangle) is filled red (no coverage) first,
 * then punched through with a green circle around every camera that's
 * online and healthy, and amber around every other registered camera
 * (including offline ones) -- a spot with a camera, even a struggling or
 * dead one, still reads as "watched, unreliably" rather than a genuine gap.
 *
 * All of it drawn on a plain HTML canvas overlaid on the map, not vector
 * geometry: the red fill traces the state outline once, each camera is one
 * filled circle. Overlapping circles simply overpaint earlier pixels
 * (amber drawn before green, so a spot within reach of both an unhealthy
 * and a healthy camera reads as reliably covered). Chosen over a turf.js
 * buffer-and-union approach specifically because this deployment's camera
 * count is headed toward 100,000+: per-pixel canvas fills stay cheap at
 * that scale where vector polygon unions would not.
 *
 * Every shape is drawn fully opaque relative to the others (no per-shape
 * transparency, so overlapping colors never blend into a muddy in-between)
 * -- the whole canvas element's CSS opacity is what blends the composited
 * result against the satellite tiles underneath.
 *
 * The canvas lives inside a dedicated Leaflet pane (a child of the map's
 * own `_mapPane`) so a plain pan slides it along for free, same as tiles.
 * Zooming is trickier: Leaflet's animated zoom doesn't just let ancestor
 * CSS transforms carry passenger elements along -- it explicitly repositions
 * anything that wants to track the transition via the `zoomanim` event, and
 * every one of Leaflet's own raster layers (ImageOverlay, GridLayer) hooks
 * that event to apply a matching scale+offset to their own element for the
 * animation's duration (see ImageOverlay.prototype._animateZoom in
 * leaflet-src.js -- this mirrors that exact pattern for this canvas). Content
 * itself is only re-rasterized at rest, on `moveend`/`zoomend`/`resize`; the
 * zoomanim handler just scales/repositions the already-drawn bitmap so it
 * visually tracks the animation, the same way a tile image does, rather than
 * sitting frozen for the transition's ~250ms and then jumping. */
export function CoverageCanvasLayer({ cameras }: CoverageCanvasLayerProps) {
  const map = useMap();

  // Static per `cameras` change -- excludes anything outside Gujarat's real
  // boundary once, rather than redoing that check on every redraw. The
  // per-redraw viewport crop (inside the effect below) is what keeps a
  // full pan/zoom cheap regardless of how large this list gets.
  const gujaratCameras = useMemo(
    () => cameras.filter((cam) => cam.long != null && isWithinGujarat(cam.lat, cam.long)),
    [cameras]
  );

  useEffect(() => {
    const pane = map.getPane('coverage') ?? map.createPane('coverage');
    pane.style.zIndex = '450';
    pane.style.pointerEvents = 'none';

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.opacity = '0.55';
    canvas.style.transformOrigin = '0 0';
    pane.appendChild(canvas);

    // What geographic area the canvas's current bitmap represents -- set at
    // the end of every `reset()`, read by the zoomanim handler to compute
    // where that same area should be framed at the animation's target zoom.
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

      // Everything below is drawn in *container*-point coordinates (screen
      // pixels relative to the map viewport's own top-left) -- valid
      // because the canvas element itself was just placed so its own
      // (0, 0) lines up with that same point, via the pane positioning
      // above.

      // Red base fill: trace the state's real outline (every ring in one
      // path, canvas's default nonzero winding rule fills each closed
      // subpath independently) rather than a bounding rectangle -- open
      // sea and slivers of neighboring states are never painted.
      ctx.fillStyle = COVERAGE_COLORS.blind;
      ctx.beginPath();
      for (const ring of GUJARAT_BOUNDARY_RINGS) {
        ring.forEach(([lat, long], i) => {
          const pt = map.latLngToContainerPoint([lat, long]);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.closePath();
      }
      ctx.fill();

      const zoom = map.getZoom();
      // Padded so a circle whose center just left the viewport, but whose
      // radius still overlaps it, doesn't pop out a frame early.
      const viewBounds = map.getBounds().pad(0.5);
      const inView = gujaratCameras.filter((cam) => viewBounds.contains(L.latLng(cam.lat, cam.long ?? 0)));

      // Amber first, green second -- a spot within reach of both an
      // unhealthy and a healthy camera should read as reliably covered.
      for (const status of ['degraded', 'operational'] as const) {
        ctx.fillStyle = COVERAGE_COLORS[status];
        for (const cam of inView) {
          if (coverageStatusForCamera(cam) !== status) continue;
          const long = cam.long ?? 0;
          const point = map.latLngToContainerPoint([cam.lat, long]);
          const radiusPx = metersToPixelRadius(cam.lat, zoom, COVERAGE_RADIUS_METERS);
          ctx.beginPath();
          ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // setPosition (above) already reset the transform to a plain
      // translate with no scale component -- clearing any leftover scale a
      // just-finished zoomanim left behind, so this freshly redrawn,
      // correctly-sized bitmap is never shown stretched.
      renderedBounds = map.getBounds();
    };

    // Leaflet fires this once per animated zoom, before `_mapPane` itself
    // moves, with the transition's *target* center/zoom -- same event and
    // same math ImageOverlay/GridLayer use to keep their own bitmaps
    // visually scaling with the animation instead of sitting static.
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
  }, [map, gujaratCameras]);

  return null;
}

export default CoverageCanvasLayer;
