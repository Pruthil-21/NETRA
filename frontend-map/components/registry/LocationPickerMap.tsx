'use client';

import React, { useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import { GUJARAT_CENTER, SATELLITE_TILES, SATELLITE_LABELS_TILES, SATELLITE_MAX_ZOOM, SATELLITE_ATTRIBUTION } from '@/lib/constants/mapConfig';

// A plain colored pin, not Leaflet's default marker image -- same reasoning
// as MapCustomMarker.tsx's divIcon: the default marker's image assets don't
// resolve reliably through this bundler, so every marker in this app is a
// small inline SVG instead.
const PIN_ICON = L.divIcon({
  className: '',
  html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 0C5.8 0 0 5.8 0 13c0 9.5 13 21 13 21s13-11.5 13-21C26 5.8 20.2 0 13 0z" fill="#3B82F6" stroke="#0B1220" stroke-width="1.5"/>
    <circle cx="13" cy="13" r="5" fill="#0B1220"/>
  </svg>`,
  iconSize: [26, 34],
  iconAnchor: [13, 34],
});

function ClickToPlace({ onPick }: { onPick: (lat: number, long: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
    },
  });
  return null;
}

/**
 * Small self-contained picker embedded in the Add Camera modal -- click
 * anywhere (or drag the pin) to set lat/long, instead of typing decimal
 * coordinates. Deliberately not the full CameraMap: no camera markers, no
 * tree/filter wiring, just "where is this one point." Dynamically imported
 * by its caller (ssr: false), same as every other Leaflet usage in this app.
 */
export default function LocationPickerMap({
  lat,
  long,
  onChange,
}: {
  lat: number | null;
  long: number | null;
  onChange: (lat: number, long: number) => void;
}) {
  const center = useMemo<[number, number]>(
    () => (lat != null && long != null ? [lat, long] : (GUJARAT_CENTER as [number, number])),
    // Only recompute on mount / when there was no prior value -- otherwise
    // every click would recenter the map under the cursor instead of just
    // moving the pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="h-48 w-full rounded overflow-hidden border border-line">
      <MapContainer center={center} zoom={lat != null ? 13 : 7} className="h-full w-full" scrollWheelZoom>
        <TileLayer attribution={SATELLITE_ATTRIBUTION} url={SATELLITE_TILES} maxZoom={SATELLITE_MAX_ZOOM} />
        <TileLayer url={SATELLITE_LABELS_TILES} maxZoom={SATELLITE_MAX_ZOOM} />
        <ClickToPlace onPick={onChange} />
        {lat != null && long != null && (
          <Marker
            position={[lat, long]}
            icon={PIN_ICON}
            draggable
            eventHandlers={{
              dragend: (e) => {
                const pos = e.target.getLatLng();
                onChange(Number(pos.lat.toFixed(6)), Number(pos.lng.toFixed(6)));
              },
            }}
          />
        )}
      </MapContainer>
    </div>
  );
}
