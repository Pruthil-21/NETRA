import { LatLngExpression } from 'leaflet';

export const GUJARAT_CENTER: LatLngExpression = [22.2587, 71.1924];
export const DEFAULT_ZOOM = 7.5;

// Esri's free World Imagery (actual satellite photography) plus its
// Reference overlay (roads, place names, administrative borders) — the same
// imagery+labels combination Google Maps' satellite view uses. No API key,
// no sign-up. Two plain raster layers, same as the single dark layer this
// replaces: no extra JS, no extra render cost, and tile requests are fully
// independent of camera streaming (different hosts, different connections),
// so this can't add latency to a live feed either way.
export const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_LABELS_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_MAX_ZOOM = 19;
export const SATELLITE_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
