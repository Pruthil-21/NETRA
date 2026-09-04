'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { Camera } from '../../types/camera';
import { Detection } from '../../types/detection';
import { createCustomMarkerIcon, createVehicleTraceIcon } from './MapCustomMarker';
import { fetchPoliceStations, PoliceStation } from '@/services/policeStationsService';
import MapPopupCard from './MapPopupCard';
import { MarkerClusterGroup } from './MarkerClusterGroup';
import { SATELLITE_TILES, SATELLITE_LABELS_TILES, SATELLITE_MAX_ZOOM, SATELLITE_ATTRIBUTION } from '@/lib/constants/mapConfig';
import { resolveSightingCamera } from '@/lib/resolveSightingCamera';
import { getCameraStreamUrl } from '@/lib/stream';
import { createHoverGraceController, HoverGraceController } from '@/lib/hoverGrace';

// Hold the hover this long before the popup grows into a live preview — long
// enough that scanning past several markers doesn't spin up a decoder per pin.
const HOVER_PREVIEW_DELAY_MS = 2000;
// Once previewing, keep the decoder alive this long after the mouse leaves the
// marker before actually tearing it down -- panning across the map often clips
// past a marker's icon briefly on the way to another one.
const HOVER_PREVIEW_GRACE_MS = 1200;

interface MapControllerProps {
  selectedCamera: Camera | null;
  routePositions: [number, number][];
}

const MapController: React.FC<MapControllerProps> = ({ selectedCamera, routePositions }) => {
  const map = useMap();

  useEffect(() => {
    const longitude = selectedCamera?.long;
    if (selectedCamera?.lat && longitude) {
      map.flyTo([selectedCamera.lat, longitude], Math.max(map.getZoom(), 14), {
        duration: 1.2,
      });
    }
  }, [selectedCamera, map]);

  // Frames the whole inferred route as soon as sightings come in, so a
  // freshly searched plate's cameras are visible without the user having to
  // hunt for them first. Runs independently of the selectedCamera effect
  // above, so clicking one sighting afterwards still flies straight to it.
  useEffect(() => {
    if (routePositions.length === 0) return;
    if (routePositions.length === 1) {
      map.flyTo(routePositions[0], Math.max(map.getZoom(), 14), { duration: 1 });
    } else {
      map.flyToBounds(L.latLngBounds(routePositions), { padding: [64, 64], duration: 1 });
    }
  }, [routePositions, map]);

  return null;
};

const VEHICLE_TRACE_ICON = createVehicleTraceIcon();

/** Interpolated marker position for the animated vehicle-trace dot: sweeps
 * leg-by-leg through `positions` in order, pauses at the last point, then
 * loops. Purely a visual read of "movement follows this sequence" — the
 * dot's position between camera points is not a real vehicle location. */
function useTracePosition(positions: [number, number][], legMs = 2500, pauseMs = 1500): [number, number] | null {
  const [animatedPos, setPos] = useState<[number, number] | null>(positions[0] ?? null);

  useEffect(() => {
    // A single (or no) point isn't animated -- rendered straight from
    // `positions` below, no setState needed here.
    if (positions.length < 2) return;

    let raf = 0;
    const legs = positions.length - 1;
    const travelMs = legs * legMs;
    const cycleMs = travelMs + pauseMs;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - start) % cycleMs;
      if (elapsed >= travelMs) {
        setPos(positions[positions.length - 1]);
      } else {
        const legIndex = Math.max(0, Math.min(legs - 1, Math.floor(elapsed / legMs)));
        const legProgress = (elapsed - legIndex * legMs) / legMs;
        const from = positions[legIndex];
        const to = positions[legIndex + 1];
        // Defensive: positions is fixed for the lifetime of this effect run,
        // so this should always be in bounds -- but a stale rAF tick landing
        // just after a re-render swaps in a shorter array is cheaper to no-op
        // than to let crash the whole map.
        if (from && to) {
          setPos([from[0] + (to[0] - from[0]) * legProgress, from[1] + (to[1] - from[1]) * legProgress]);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [positions, legMs, pauseMs]);

  return positions.length < 2 ? (positions[0] ?? null) : animatedPos;
}

const VehicleTraceMarker: React.FC<{ positions: [number, number][] }> = ({ positions }) => {
  const pos = useTracePosition(positions);
  if (!pos) return null;
  return <Marker position={pos} icon={VEHICLE_TRACE_ICON} interactive={false} />;
};

interface CameraMapProps {
  cameras: Camera[];
  selectedCamera: Camera | null;
  onSelectCamera: (cam: Camera) => void;
  // Optional: a plate's sighting history (vehicle-search feature), already
  // ordered chronologically by the caller (GET /detections' own contract
  // guarantees ascending detected_at). Plotted as a route on top of the
  // regular camera pins. Omitting this prop leaves every other consumer of
  // CameraMap byte-identical to before.
  sightings?: Detection[];
}

export const CameraMap: React.FC<CameraMapProps> = ({
  cameras,
  selectedCamera,
  onSelectCamera,
  sightings,
}) => {
  // Police station pins -- a separate data source from cameras (backend-registry's
  // /police-stations, not /cameras), fetched once on mount. Non-fatal on failure: the
  // map is still fully usable for camera monitoring without station pins.
  const [stations, setStations] = useState<PoliceStation[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchPoliceStations()
      .then((data) => {
        if (!cancelled) setStations(data);
      })
      .catch(() => {
        // Swallowed -- station pins are supplementary, not required for the map to work.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sightingPoints = useMemo(() => {
    if (!sightings || sightings.length === 0) return [];
    const cameraById = new Map(cameras.map((cam) => [cam.id, cam]));
    // Defensive re-sort: this component only trusts detected_at order, not
    // caller order, since the route/animation direction depends on it.
    return [...sightings]
      .sort((a, b) => new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime())
      .map((sighting) => {
        const camera = resolveSightingCamera(sighting, cameraById);
        if (!camera) return null;
        return { sighting, camera };
      })
      .filter((point): point is { sighting: Detection; camera: Camera } => point !== null);
  }, [sightings, cameras]);

  const routePositions = useMemo(
    () => sightingPoints.map(({ camera }) => [camera.lat, camera.long ?? 0] as [number, number]),
    [sightingPoints]
  );

  const routeCameraIds = useMemo(
    () => new Set(sightingPoints.map(({ camera }) => camera.id)),
    [sightingPoints]
  );

  // Which marker's popup should render the live preview -- only ever one at a
  // time, since only one marker can be hovered. The Leaflet marker instances
  // themselves are refs (not React state) so opening/closing a popup on hover
  // doesn't need a re-render just to call .openPopup()/.closePopup().
  const [previewingCameraId, setPreviewingCameraId] = useState<number | null>(null);
  const markerRefs = useRef<Map<number, L.Marker>>(new Map());
  // One stable ref-callback per camera id, reused across renders -- without this,
  // the inline arrow passed to each <Marker ref={...}> below is a brand-new function
  // every render, which makes React detach-then-reattach every marker's ref on every
  // re-render (this component re-renders every HEALTH_CHECK_INTERVAL_MS from the
  // background connectivity poller in CameraRegistryContext, whether or not this
  // specific camera's own data changed). Built via useMemo (keyed on the stable set of
  // camera ids, not the `cameras` array reference -- see below) rather
  // than a lazy ref-cache read during render -- the closures themselves only touch
  // markerRefs.current when React actually calls them (mount/unmount), never here.
  const cameraIdKey = useMemo(() => cameras.map((cam) => cam.id).join(','), [cameras]);
  const markerRefCallbacks = useMemo(() => {
    const map = new Map<number, (marker: L.Marker | null) => void>();
    for (const cam of cameras) {
      // markerRefs is only read once React actually invokes this ref callback, which
      // happens during commit (mount/unmount), never synchronously during render. The
      // rule flags any ref captured in a closure handed to another function as a
      // precaution since it can't trace invocation timing across the Map.set/
      // <Marker ref={...}> boundary; verified safe here.
      // eslint-disable-next-line react-hooks/refs
      map.set(cam.id, (marker) => {
        if (marker) markerRefs.current.set(cam.id, marker);
        else markerRefs.current.delete(cam.id);
      });
    }
    return map;
    // Keyed on the stable set of camera ids (cameraIdKey), not the `cameras`
    // array reference -- that reference still changes on every real
    // connectivity-status flip (see updateCameraConnectivity in
    // CameraRegistryContext.tsx), which previously forced every marker's ref
    // to detach/reattach on every such flip. During a hover, if the 20s
    // background health-poll flipped even one *other* camera's status, all
    // marker refs churned and Leaflet closed whatever popup was open --
    // this is the actual cause of the reported "hover flickers and shows
    // nothing" bug. Keying on ids-only means a status-only update never
    // touches marker refs; only cameras actually being added/removed does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraIdKey]);
  // One hover-grace controller per camera id, created lazily on first hover and
  // reused after -- mirrors the per-marker-ref cache above for the same reason
  // (this component manages every marker from one instance, so per-marker state
  // lives in a Map rather than one-hook-per-marker).
  const hoverControllers = useRef<Map<number, HoverGraceController>>(new Map());
  const getHoverController = useCallback((camId: number) => {
    let controller = hoverControllers.current.get(camId);
    if (!controller) {
      controller = createHoverGraceController(
        HOVER_PREVIEW_DELAY_MS,
        HOVER_PREVIEW_GRACE_MS,
        () => setPreviewingCameraId(camId),
        () => {
          setPreviewingCameraId((current) => (current === camId ? null : current));
          markerRefs.current.get(camId)?.closePopup();
        }
      );
      hoverControllers.current.set(camId, controller);
    }
    return controller;
  }, []);

  const handleMarkerHoverStart = useCallback(
    (camId: number) => {
      markerRefs.current.get(camId)?.openPopup();
      getHoverController(camId).hoverStart();
    },
    [getHoverController]
  );

  const handleMarkerHoverEnd = useCallback(
    (camId: number) => {
      getHoverController(camId).hoverEnd();
    },
    [getHoverController]
  );

  useEffect(
    () => () => {
      hoverControllers.current.forEach((controller) => controller.cancel());
    },
    []
  );

  return (
    <div className="relative w-full h-full">
      {sightingPoints.length > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] px-3 py-1.5 rounded bg-panel/90 border border-blue-500/40 shadow-lg text-center pointer-events-none">
          <p className="text-[11px] font-semibold tracking-wide text-blue-300 uppercase">
            {/* Scenario-run searches (GET /vehicle-traces) carry their own
                caption -- e.g. "...from simulated camera sightings" -- so a
                demo replay is never confused for the general feature's real
                detection history. Falls back to the generic wording for a
                normal plate search. */}
            {sightingPoints[0].sighting.route_label || 'Inferred route from camera sightings'}
          </p>
          <p className="text-[10px] text-slate-400">Not GPS tracking — derived from camera detections only</p>
        </div>
      )}

      <MapContainer
        center={[22.2587, 71.1924]}
        zoom={7}
        className="w-full h-full bg-slate-950"
      >
        <TileLayer attribution={SATELLITE_ATTRIBUTION} url={SATELLITE_TILES} maxZoom={SATELLITE_MAX_ZOOM} />
        <TileLayer url={SATELLITE_LABELS_TILES} maxZoom={SATELLITE_MAX_ZOOM} />

        <MapController selectedCamera={selectedCamera} routePositions={routePositions} />

        <MarkerClusterGroup chunkedLoading maxClusterRadius={40} spiderfyOnMaxZoom showCoverageOnHover={false}>
          {cameras.map((cam: Camera) => {
            const longitude = cam.long ?? 0;
            const isSelected = selectedCamera?.id === cam.id;
            const isOnRoute = routeCameraIds.has(cam.id);
            return (
              <Marker
                key={cam.id}
                ref={markerRefCallbacks.get(cam.id)}
                position={[cam.lat, longitude]}
                icon={createCustomMarkerIcon(cam, isSelected, isOnRoute)}
                eventHandlers={{
                  click: () => onSelectCamera(cam),
                  mouseover: () => handleMarkerHoverStart(cam.id),
                  mouseout: () => handleMarkerHoverEnd(cam.id),
                }}
              >
                <Popup className="dark-gis-popup">
                  <MapPopupCard
                    camera={cam}
                    onInspect={() => onSelectCamera(cam)}
                    isPreviewing={previewingCameraId === cam.id}
                    previewSrc={previewingCameraId === cam.id ? getCameraStreamUrl(cam).url : null}
                  />
                </Popup>
              </Marker>
            );
          })}
        </MarkerClusterGroup>

        {routePositions.length > 1 && (
          <Polyline
            positions={routePositions}
            pathOptions={{ color: '#3B82F6', weight: 3, dashArray: '6 6', opacity: 0.8 }}
          />
        )}

        {routePositions.length > 1 && <VehicleTraceMarker positions={routePositions} />}

        {sightingPoints.map(({ sighting, camera }, index) => (
          <CircleMarker
            key={sighting.id}
            center={[camera.lat, camera.long ?? 0]}
            radius={7}
            pathOptions={{ color: '#3B82F6', fillColor: '#60A5FA', fillOpacity: 0.9, weight: 2 }}
            eventHandlers={{
              click: () => onSelectCamera(camera),
            }}
          >
            <Tooltip permanent direction="top" offset={[0, -6]} className="sighting-order-tooltip">
              {index + 1}
            </Tooltip>
            <Popup className="dark-gis-popup">
              <div className="p-1 min-w-[160px] text-slate-100 text-xs">
                <p className="font-semibold text-white mb-1">{camera.name || `Camera #${camera.id}`}</p>
                <p className="text-slate-400">{new Date(sighting.detected_at).toLocaleString()}</p>
                {sighting.confidence != null && (
                  <p className="text-slate-500 mt-1">
                    Confidence: {(sighting.confidence * 100).toFixed(0)}%
                  </p>
                )}
                <p className="text-slate-600 mt-1.5 text-[10px]">Click marker to open live feed</p>
              </div>
            </Popup>
          </CircleMarker>
        ))}

        {stations.map((station: PoliceStation) => (
          <CircleMarker
            key={`station-${station.id}`}
            center={[station.lat, station.long]}
            radius={8}
            pathOptions={{ color: '#F59E0B', fillColor: '#FBBF24', fillOpacity: 0.85, weight: 2 }}
          >
            <Popup className="dark-gis-popup">
              <div className="p-1 min-w-[160px] text-slate-100 text-xs">
                <p className="font-semibold text-white mb-1">{station.name}</p>
                <p className="text-slate-400">{station.district}</p>
                <p className="text-slate-500 mt-1">{station.contact || 'No contact on file'}</p>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
};

export default CameraMap;