'use client';

import React from 'react';
import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { Camera } from '../../types/camera';
import MapPopupCard from './MapPopupCard';

const createIcon = (status: string) => {
  const color = status === 'online' ? '#10B981' : '#EF4444';
  return L.divIcon({
    className: 'netra-marker',
    html: `<div style="background-color:${color};width:16px;height:16px;border-radius:50%;border:2px solid #0f172a;box-shadow:0 0 8px ${color}88;"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
};

export default function MapCustomMarker({
  camera,
  onSelect,
}: {
  camera: Camera;
  onSelect: (cam: Camera) => void;
}) {
  return (
    <Marker position={[camera.lat, camera.long]} icon={createIcon(camera.connectivity_status)}>
      <MapPopupCard camera={camera} onInspect={() => onSelect(camera)} />
    </Marker>
  );
}