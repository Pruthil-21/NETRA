// components/map/MarkerClusterGroup.tsx
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';

interface MarkerClusterGroupProps {
  children: React.ReactNode;
}

export const MarkerClusterGroup: React.FC<MarkerClusterGroupProps> = ({ children }) => {
  const map = useMap();

  useEffect(() => {
    const clusterGroup = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    });

    map.addLayer(clusterGroup);

    return () => {
      map.removeLayer(clusterGroup);
    };
  }, [map]);

  return <>{children}</>;
};