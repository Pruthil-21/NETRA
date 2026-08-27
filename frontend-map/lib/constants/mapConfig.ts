import { LatLngExpression } from 'leaflet';

export const GUJARAT_CENTER: LatLngExpression = [22.2587, 71.1924];
export const DEFAULT_ZOOM = 7.5;
// CartoDB's anonymous raster tiles now require a free API key (else they're
// watermarked "API KEY REQUIRED"). Get one at https://carto.com/basemaps/apikey/
// and set NEXT_PUBLIC_CARTO_API_KEY in `.env` — see `.env.example`.
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;
export const CARTO_DARK_TILES = CARTO_API_KEY
  ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`
  : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const CARTO_ATTRIBUTION =
  '&copy; <a href="https://carto.com/">CartoDB</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';