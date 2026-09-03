'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { AlertTriangle } from 'lucide-react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import { MarkerClusterGroup } from '@/components/map/MarkerClusterGroup';
import { scaleCameraService } from '@/services/scaleCameraService';
import { ScaleCamera, BoundingBox, DistrictCount } from '@/types/scaleCamera';
import { SATELLITE_TILES, SATELLITE_MAX_ZOOM, SATELLITE_ATTRIBUTION } from '@/lib/constants/mapConfig';

const MAX_MARKERS_RENDERED = 500;
// Zoomed out past this, the visible bbox likely spans the whole state --
// showing a per-camera marker for a 500km-wide viewport is both slow and
// useless; a district-count summary is what the requirement actually asks for.
const CLUSTER_ONLY_MIN_ZOOM = 9;

// A distinct divIcon for synthetic cameras -- amber/dashed rather than the
// real map's default marker icon, so a synthetic pin never reads as a real
// live camera at a glance. Built once (module scope), not per-render.
const SYNTHETIC_ICON = L.divIcon({
  className: '',
  html: '<div style="width:12px;height:12px;border-radius:9999px;background:#f59e0b;border:2px dashed #78350f;" title="Synthetic camera"></div>',
  iconSize: [12, 12],
});

function boundsFrom(map: ReturnType<typeof useMap>): BoundingBox {
  const b = map.getBounds();
  return { minLat: b.getSouth(), maxLat: b.getNorth(), minLong: b.getWest(), maxLong: b.getEast() };
}

function BoundsWatcher({ onBoundsChange }: { onBoundsChange: (bbox: BoundingBox, zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    onBoundsChange(boundsFrom(map), map.getZoom());
  }, [map, onBoundsChange]);

  useMapEvents({
    moveend: () => onBoundsChange(boundsFrom(map), map.getZoom()),
    zoomend: () => onBoundsChange(boundsFrom(map), map.getZoom()),
  });

  return null;
}

interface ScaleMapProps {
  onSelectCamera: (camera: ScaleCamera) => void;
  /** Called with ('map-pan-or-zoom', durationMs) after each bounds-change
   * fetch settles -- this is what "map interaction responsiveness"
   * (requirement 12) actually measures: how long the map took to show data
   * for a new viewport, not a synthetic/unrelated timing. Optional so
   * ScaleMap's own tests (which don't care about metrics) don't need to
   * pass one. */
  onInteraction?: (label: string, durationMs: number) => void;
}

export function ScaleMap({ onSelectCamera, onInteraction }: ScaleMapProps) {
  const [cameras, setCameras] = useState<ScaleCamera[]>([]);
  const [zoom, setZoom] = useState(7);
  const [districts, setDistricts] = useState<DistrictCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against an old, slow request's response landing after a newer,
  // faster one -- without this, panning quickly could leave the map showing
  // a stale viewport's cameras. Incremented on every bounds change; a
  // response is only applied if its own captured id still matches the
  // latest one when it resolves.
  const latestRequestId = useRef(0);

  const handleBoundsChange = useCallback(async (bbox: BoundingBox, currentZoom: number) => {
    const requestId = ++latestRequestId.current;
    const interactionStart = performance.now();

    try {
      if (currentZoom < CLUSTER_ONLY_MIN_ZOOM) {
        // Zoomed out: don't fetch individual cameras at all -- a real
        // aggregate GROUP BY query (Task 4), not a client-side count over one
        // possibly-truncated page.
        const result = await scaleCameraService.getDistrictSummary(bbox);
        if (requestId !== latestRequestId.current) return; // a newer request has since superseded this one
        setZoom(currentZoom);
        setDistricts(result);
        setCameras([]);
        setError(null);
        onInteraction?.('map-bounds-change', performance.now() - interactionStart);
        return;
      }

      setDistricts(null);
      const page = await scaleCameraService.listPage({ bbox, limit: MAX_MARKERS_RENDERED });
      if (requestId !== latestRequestId.current) return; // stale -- discard
      setZoom(currentZoom);
      setCameras(page.cameras);
      setError(null);
      onInteraction?.('map-bounds-change', performance.now() - interactionStart);
    } catch (err) {
      // Without this, a fetch failure here becomes a genuinely unhandled
      // promise rejection (this callback is invoked fire-and-forget from
      // BoundsWatcher, never awaited) and leaves stale markers on screen
      // with zero indication -- surface it instead: log it, flag it in the
      // UI, and still fire onInteraction so the metrics panel doesn't
      // silently under-count this interaction.
      if (requestId !== latestRequestId.current) return; // a newer request already superseded this one
      console.error('ScaleMap: failed to load data for the current viewport', err);
      setError(err instanceof Error ? err.message : 'Failed to load map data');
      onInteraction?.('map-bounds-change-error', performance.now() - interactionStart);
    }
  }, [onInteraction]);

  return (
    <div className="relative w-full h-full">
      <MapContainer center={[22.2587, 71.1924]} zoom={7} className="w-full h-full bg-slate-950">
        <TileLayer attribution={SATELLITE_ATTRIBUTION} url={SATELLITE_TILES} maxZoom={SATELLITE_MAX_ZOOM} />
        <BoundsWatcher onBoundsChange={handleBoundsChange} />
        <MarkerClusterGroup chunkedLoading maxClusterRadius={60} spiderfyOnMaxZoom showCoverageOnHover={false}>
          {cameras.map((cam) => (
            <SyntheticMarker key={cam.id} camera={cam} onSelect={onSelectCamera} />
          ))}
        </MarkerClusterGroup>
      </MapContainer>

      {/* Hidden from view (not visually part of the UI) -- exists so tests
          can assert on the currently-loaded camera count without reaching
          into mocked Marker internals. */}
      <span data-testid="scale-map-camera-count" className="sr-only">{cameras.length}</span>

      {error && (
        <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2 px-3 py-1.5 rounded-lg border border-signal-red/30 bg-panel/90 text-signal-red text-[11px]">
          <AlertTriangle size={14} />
          Map data may be stale — {error}
        </div>
      )}

      {zoom < CLUSTER_ONLY_MIN_ZOOM && districts && (
        <div className="absolute top-3 left-3 z-[1000] bg-panel/90 border border-line rounded-lg p-3 max-h-64 overflow-y-auto text-[11px]">
          <p className="font-semibold text-white mb-1.5 uppercase tracking-wide text-[10px]">District Summary (Simulation)</p>
          {districts.map(({ district, count }) => (
            <div key={district} className="flex justify-between gap-4 text-slate-400">
              <span>{district}</span>
              <span className="text-slate-300 font-mono">{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SyntheticMarker({ camera, onSelect }: { camera: ScaleCamera; onSelect: (c: ScaleCamera) => void }) {
  // Defense-in-depth: the backend now enforces is_synthetic=true for every
  // row this page's include_synthetic=true calls return (see
  // cameras_service.list_cameras_page), so a non-synthetic camera reaching
  // this component should never happen in practice -- but if it does, it
  // must not be mislabeled/mis-iconed as synthetic.
  return (
    <Marker
      position={[camera.lat, camera.long]}
      icon={camera.is_synthetic ? SYNTHETIC_ICON : undefined}
      title={camera.is_synthetic ? `${camera.name} (Synthetic)` : camera.name}
      eventHandlers={{ click: () => onSelect(camera) }}
    />
  );
}
