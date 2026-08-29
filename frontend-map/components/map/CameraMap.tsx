'use client';

import React, { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { Camera } from '../../types/camera';
import { Detection } from '../../types/detection';
import { createCustomMarkerIcon } from './MapCustomMarker';
import MapPopupCard from './MapPopupCard';
import { MarkerClusterGroup } from './MarkerClusterGroup';
import { CARTO_DARK_TILES, CARTO_ATTRIBUTION } from '@/lib/constants/mapConfig';

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
  const sightingPoints = useMemo(() => {
    if (!sightings || sightings.length === 0) return [];
    const cameraById = new Map(cameras.map((cam) => [cam.id, cam]));
    return sightings
      .map((sighting) => {
        const camera = cameraById.get(sighting.camera_id);
        if (!camera) return null;
        return { sighting, camera };
      })
      .filter((point): point is { sighting: Detection; camera: Camera } => point !== null);
  }, [sightings, cameras]);

  const routePositions = sightingPoints.map(
    ({ camera }) => [camera.lat, camera.long ?? 0] as [number, number]
  );

  return (
    <MapContainer
      center={[22.2587, 71.1924]}
      zoom={7}
      className="w-full h-full bg-slate-950"
    >
      <TileLayer attribution={CARTO_ATTRIBUTION} url={CARTO_DARK_TILES} />

      <MapController selectedCamera={selectedCamera} />

      <MarkerClusterGroup chunkedLoading maxClusterRadius={40} spiderfyOnMaxZoom showCoverageOnHover={false}>
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

      {routePositions.length > 1 && (
        <Polyline
          positions={routePositions}
          pathOptions={{ color: '#3B82F6', weight: 3, dashArray: '6 6', opacity: 0.8 }}
        />
      )}

      {sightingPoints.map(({ sighting, camera }, index) => (
        <CircleMarker
          key={sighting.id}
          center={[camera.lat, camera.long ?? 0]}
          radius={7}
          pathOptions={{ color: '#3B82F6', fillColor: '#60A5FA', fillOpacity: 0.9, weight: 2 }}
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
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
};

export default CameraMap;