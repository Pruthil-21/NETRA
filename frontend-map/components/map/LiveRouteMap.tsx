'use client';

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap } from 'react-leaflet';
import { GeoPosition } from '@/lib/geolocation';
import { fetchDrivingRoute, formatDistance, formatDuration, formatEta, DrivingRoute } from '@/lib/routing';
import { SATELLITE_TILES, SATELLITE_LABELS_TILES, SATELLITE_MAX_ZOOM, SATELLITE_ATTRIBUTION } from '@/lib/constants/mapConfig';

// Re-requesting the road route on every GPS tick (watchPosition can fire
// far more often than this) would hammer OSRM's public demo server for no
// visible benefit during a demo -- refetch on a fixed cadence instead,
// using whatever the latest officer position is at that moment, plus
// immediately whenever the destination itself changes (a newer sighting).
const ROUTE_REFRESH_MS = 10000;

interface LiveRouteMapProps {
  officerPosition: GeoPosition;
  /** The plate's last-known camera location. Can change while this map is
   * mounted (a newer sighting at a different camera) -- triggers an
   * immediate route recompute to the new destination. */
  destination: { name: string; lat: number; long: number };
}

// Fits the WHOLE route into view exactly once per destination -- a genuinely
// new sighting/camera, not the officer's own GPS ticking. Previously this
// re-fit on every change to either route endpoint, including the officer's
// own position updating every few seconds -- so zooming in on yourself got
// immediately overridden by a zoom-out to the whole route on the next GPS
// tick. Destination is the only thing that should trigger a re-fit now.
const FitRoute: React.FC<{ coordinates: [number, number][]; destinationKey: string }> = ({
  coordinates,
  destinationKey,
}) => {
  const map = useMap();
  useEffect(() => {
    if (coordinates.length === 0) return;
    map.flyToBounds(L.latLngBounds(coordinates), { padding: [64, 64], duration: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationKey, map]);
  return null;
};

// Follow-me: recenters on the officer's own live position as it updates,
// preserving whatever zoom level the officer has chosen -- like turn-by-turn
// navigation, not a repeated fit-to-bounds. Skips the very first position
// (FitRoute already frames that) so the two don't fight on mount.
const FollowOfficer: React.FC<{ officerPosition: GeoPosition }> = ({ officerPosition }) => {
  const map = useMap();
  const hasFramedInitial = useRef(false);
  useEffect(() => {
    if (!hasFramedInitial.current) {
      hasFramedInitial.current = true;
      return;
    }
    map.panTo([officerPosition.lat, officerPosition.long], { animate: true, duration: 0.8 });
  }, [officerPosition.lat, officerPosition.long, map]);
  return null;
};

export const LiveRouteMap: React.FC<LiveRouteMapProps> = ({ officerPosition, destination }) => {
  const [route, setRoute] = useState<DrivingRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const officerPositionRef = useRef(officerPosition);
  useEffect(() => {
    officerPositionRef.current = officerPosition;
  }, [officerPosition]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await fetchDrivingRoute(officerPositionRef.current, {
          lat: destination.lat,
          long: destination.long,
        });
        if (!cancelled) {
          setRoute(result);
          setRouteError(null);
        }
      } catch (err) {
        if (!cancelled) setRouteError(err instanceof Error ? err.message : 'Failed to compute route');
      }
    };
    refresh();
    const interval = setInterval(refresh, ROUTE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [destination.lat, destination.long]);

  const destPos: GeoPosition = { lat: destination.lat, long: destination.long };
  const path = route?.coordinates ?? [
    [officerPosition.lat, officerPosition.long],
    [destPos.lat, destPos.long],
  ];

  return (
    <div className="relative w-full h-full">
      <MapContainer center={[officerPosition.lat, officerPosition.long]} zoom={12} className="w-full h-full bg-slate-950">
        <TileLayer attribution={SATELLITE_ATTRIBUTION} url={SATELLITE_TILES} maxZoom={SATELLITE_MAX_ZOOM} />
        <TileLayer url={SATELLITE_LABELS_TILES} maxZoom={SATELLITE_MAX_ZOOM} />

        <FitRoute coordinates={path} destinationKey={`${destination.lat},${destination.long}`} />
        <FollowOfficer officerPosition={officerPosition} />

        <Polyline
          positions={path}
          pathOptions={{
            color: '#3B82F6',
            weight: 5,
            opacity: 0.85,
            dashArray: route && !route.isRoadRoute ? '8 8' : undefined,
          }}
        />

        <CircleMarker
          center={[officerPosition.lat, officerPosition.long]}
          radius={8}
          pathOptions={{ color: '#22C55E', fillColor: '#4ADE80', fillOpacity: 0.95, weight: 2 }}
        >
          <Popup className="dark-gis-popup">Your current location</Popup>
        </CircleMarker>

        <CircleMarker
          center={[destPos.lat, destPos.long]}
          radius={8}
          pathOptions={{ color: '#EF4444', fillColor: '#F87171', fillOpacity: 0.95, weight: 2 }}
        >
          <Popup className="dark-gis-popup">{destination.name} — last sighting</Popup>
        </CircleMarker>
      </MapContainer>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] px-4 py-2.5 rounded bg-panel/95 border border-line shadow-xl flex items-center gap-5 text-xs">
        {!route && !routeError && <span className="text-slate-400">Calculating route…</span>}
        {routeError && <span className="text-signal-red">{routeError}</span>}
        {route && (
          <>
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px]">Distance</p>
              <p className="text-white font-semibold font-mono">{formatDistance(route.distanceMeters)}</p>
            </div>
            <div className="h-6 w-px bg-line" />
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px]">Remaining time</p>
              <p className="text-white font-semibold font-mono">{formatDuration(route.durationSeconds)}</p>
            </div>
            <div className="h-6 w-px bg-line" />
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px]">ETA</p>
              <p className="text-white font-semibold font-mono">{formatEta(route.durationSeconds)}</p>
            </div>
            {!route.isRoadRoute && (
              <span className="text-amber-400 text-[10px] max-w-[140px]">
                Road routing unavailable — straight-line estimate
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default LiveRouteMap;
