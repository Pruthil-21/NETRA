'use client';

import React from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';

import { Camera } from '../../types/camera';
import { GUJARAT_CENTER, DEFAULT_ZOOM, CARTO_DARK_TILES, CARTO_ATTRIBUTION } from '../../lib/constants/mapConfig';
import MapCustomMarker from './MapCustomMarker';

export default function CameraMap({
  cameras,
  onSelectCamera,
}: {
  cameras: Camera[];
  selectedCamera: Camera | null;
  onSelectCamera: (cam: Camera) => void;
}) {
  return (
    <MapContainer center={GUJARAT_CENTER} zoom={DEFAULT_ZOOM} className="w-full h-full">
      <TileLayer url={CARTO_DARK_TILES} attribution={CARTO_ATTRIBUTION} />
      {cameras.map((cam) => (
        <MapCustomMarker key={cam.id} camera={cam} onSelect={onSelectCamera} />
      ))}
    </MapContainer>
  );
}