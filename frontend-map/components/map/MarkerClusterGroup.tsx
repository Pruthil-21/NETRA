// components/map/MarkerClusterGroup.tsx
import type { PropsWithChildren } from 'react';
import L from 'leaflet';
import 'leaflet.markercluster';
import { createElementObject, createLayerComponent, extendContext } from '@react-leaflet/core';

// The previous version created its own L.markerClusterGroup() imperatively
// via useMap()+useEffect and added it to the map, but never exposed it as
// the `layerContainer` in React-Leaflet's context. Every child <Marker>
// looks up that context to decide what to attach itself to — without it,
// markers default to attaching straight to the map, completely bypassing
// the cluster group (so clustering silently never ran: cameras sharing the
// exact same coordinates just rendered as fully overlapping pins instead of
// a grouped count bubble). createLayerComponent is the same primitive
// react-leaflet's own <LayerGroup> is built on, and fixes that by wiring
// this group up as the real container children register onto.
interface MarkerClusterGroupProps extends L.MarkerClusterGroupOptions, PropsWithChildren {}

export const MarkerClusterGroup = createLayerComponent<L.MarkerClusterGroup, MarkerClusterGroupProps>(
  function createMarkerClusterGroup({ children: _children, ...options }, ctx) {
    const group = L.markerClusterGroup(options);
    return createElementObject(group, extendContext(ctx, { layerContainer: group }));
  }
);
