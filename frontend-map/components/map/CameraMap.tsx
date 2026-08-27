'use client';

import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Camera } from '../../types/camera';
import { createCustomMarkerIcon } from './MapCustomMarker';
import MapPopupCard from './MapPopupCard';
import { MarkerClusterGroup } from './MarkerClusterGroup';

interface MapControllerProps {
  selectedCamera: Camera | null;
}

const MapController: React.FC<MapControllerProps> = ({ selectedCamera }) => {
  const map = useMap();

  useEffect(() => {
    const longitude = selectedCamera?.long;
    if (selectedCamera?.lat && longitude) {
      map.flyTo([selectedCamera.lat, longitude], Math.max(map.getZoom(), 14), {
        duration: 1.2,
      });
    }
  }, [selectedCamera, map]);

  return null;
};

interface CameraMapProps {
  cameras: Camera[];
  selectedCamera: Camera | null;
  onSelectCamera: (cam: Camera) => void;
}

export const CameraMap: React.FC<CameraMapProps> = ({
  cameras,
  selectedCamera,
  onSelectCamera,
}) => {
  return (
    <MapContainer
      center={[22.2587, 71.1924]}
      zoom={7}
      className="w-full h-full bg-slate-950"
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />

      <MapController selectedCamera={selectedCamera} />

      <MarkerClusterGroup>
        {cameras.map((cam: Camera) => {
          const longitude = cam.long ?? 0;
          const isSelected = selectedCamera?.id === cam.id;
          return (
            <Marker
              key={cam.id}
              position={[cam.lat, longitude]}
              icon={createCustomMarkerIcon(cam, isSelected)}
              eventHandlers={{
                click: () => onSelectCamera(cam),
              }}
            >
              <Popup className="dark-gis-popup">
                <MapPopupCard camera={cam} onInspect={() => onSelectCamera(cam)} />
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>
    </MapContainer>
  );
};

export default CameraMap;