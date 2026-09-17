import L from 'leaflet';
import { Camera } from '../../types/camera';

// Model 1's GIS map layer requirement lists "department, camera type,
// status, and coverage" -- department (city/area) and status (the
// circle/diamond shape below) already existed, coverage is its own canvas
// layer; camera type didn't have a symbology at all. Real GIS layer panels
// (ArcGIS "unique values renderer", QGIS categorized symbology) encode a
// category as an icon/badge rather than a filter that just hides things --
// this is that: a small colored corner badge, independent of and layered
// on top of the existing status shape, not a replacement for it. Free-text
// camera_type values are normalized case/punctuation-insensitively so
// "PTZ", "ptz", "PTZ Camera" all match the same badge; anything
// unrecognized gets a neutral "?" badge rather than silently no badge,
// so an unusual value is visible as data-needing-cleanup, not invisible.
type CameraTypeBadge = { letter: string; color: string; label: string };

// ptz/dome/bullet/anpr are this registry's actual current camera_type values
// (see types/camera.ts's CameraType union); fixed/cmount/daynight are kept
// too since the backend column is free TEXT, not a DB-enforced enum (see
// backend-registry/app/schema.sql) -- a future onboarded camera using one of
// those values still gets a real badge instead of silently falling through
// to "Other".
const CAMERA_TYPE_BADGES: Record<string, CameraTypeBadge> = {
  ptz: { letter: 'P', color: '#8B5CF6', label: 'PTZ' },
  dome: { letter: 'D', color: '#F59E0B', label: 'Dome' },
  bullet: { letter: 'B', color: '#14B8A6', label: 'Bullet' },
  anpr: { letter: 'A', color: '#22C55E', label: 'ANPR' },
  fixed: { letter: 'F', color: '#0EA5E9', label: 'Fixed' },
  cmount: { letter: 'C', color: '#EC4899', label: 'C-Mount' },
  daynight: { letter: 'N', color: '#6366F1', label: 'Day/Night' },
};

const UNKNOWN_TYPE_BADGE: CameraTypeBadge = { letter: '?', color: '#64748B', label: 'Other' };

export function normalizeCameraTypeKey(cameraType: string | null | undefined): string {
  return (cameraType || '').toLowerCase().replace(/[^a-z]/g, '');
}

export function getCameraTypeBadge(cameraType: string | null | undefined): CameraTypeBadge {
  const key = normalizeCameraTypeKey(cameraType);
  // Substring match, not exact -- a real registry value like "PTZ Dome" or
  // "Fixed-IR" still resolves to a sensible badge instead of falling
  // through to "Other" just because it isn't byte-for-byte one of the
  // known keys.
  for (const [needle, badge] of Object.entries(CAMERA_TYPE_BADGES)) {
    if (key.includes(needle)) return badge;
  }
  return UNKNOWN_TYPE_BADGE;
}

export const CAMERA_TYPE_LEGEND: CameraTypeBadge[] = [
  ...Object.values(CAMERA_TYPE_BADGES),
  UNKNOWN_TYPE_BADGE,
];

export const createCustomMarkerIcon = (
  camera: Camera,
  isSelected: boolean,
  isOnRoute: boolean = false,
  isHighlighted: boolean = false,
  showCameraType: boolean = false
) => {
  const status = (camera.connectivity_status || 'offline').toLowerCase();
  const isOnline = status === 'online';
  const color = isOnline ? '#22C55E' : '#EF4444';

  // Online = solid circle with a radar-sweep ring (the app's one ambient
  // motion signature); offline = a strike diamond so status is legible
  // without relying on color alone.
  const innerShape = isOnline
    ? `<circle cx="16" cy="16" r="5" fill="${color}" />`
    : `<rect x="11" y="11" width="10" height="10" transform="rotate(45 16 16)" fill="none" stroke="${color}" stroke-width="2.5" />
       <line x1="12" y1="12" x2="20" y2="20" stroke="${color}" stroke-width="2" />`;

  // isOnRoute (a vehicle-search sighting camera) gets a static blue ring —
  // no ping, since up to several of these render at once and a shared pulse
  // would be visual noise. isSelected (the one open in the detail drawer)
  // still gets the louder ping ring and wins if both apply. isHighlighted (a
  // camera under the tree's currently selected district/area) gets a static
  // amber ring, lowest priority of the three -- it's a coarse "this is the
  // selected group" cue, not something that should compete visually with an
  // actual selection or an active sighting route.
  const highlightRing = isSelected
    ? `<div class="absolute -inset-1.5 rounded-full border-2 border-command bg-command/20 animate-ping"></div>
       <div class="absolute -inset-1 rounded-full border-2 border-command"></div>`
    : isOnRoute
      ? `<div class="absolute -inset-1 rounded-full border-2 border-blue-400 bg-blue-400/10"></div>`
      : isHighlighted
        ? `<div class="absolute -inset-1 rounded-full border-2 border-amber-400 bg-amber-400/10"></div>`
        : '';

  // A small corner badge, not a shape swap -- keeps the existing
  // circle/diamond status language fully legible while adding the type
  // dimension on top. Only computed/rendered when the Camera Type layer is
  // actually on, so an officer who never toggles it sees byte-identical
  // markers to before this feature existed.
  const typeBadge = showCameraType
    ? (() => {
        const badge = getCameraTypeBadge(camera.camera_type);
        return `<svg viewBox="0 0 32 32" class="absolute inset-0 w-8 h-8">
          <circle cx="25" cy="25" r="6.5" fill="${badge.color}" stroke="#05070A" stroke-width="1.5" />
          <text x="25" y="25" text-anchor="middle" dominant-baseline="central"
                font-size="8" font-weight="700" fill="#05070A">${badge.letter}</text>
        </svg>`;
      })()
    : '';

  const html = `
    <div class="relative flex items-center justify-center w-8 h-8 ${isOnline ? 'radar-sweep' : ''}">
      ${highlightRing}
      <svg viewBox="0 0 32 32" class="w-8 h-8 drop-shadow-md">
        <circle cx="16" cy="16" r="14" fill="#05070A" stroke="${color}" stroke-width="${isSelected ? '3' : '2'}" />
        ${innerShape}
      </svg>
      ${typeBadge}
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-camera-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
};

// Module-scope (not a React ref/state) on purpose -- the cached value is a
// pure function of the key alone (same camera id + status + selection/
// route/highlight combo always produces the identical icon), so mutating
// this plain Map during a component's render is safe and doesn't need to
// go through a ref or effect the way component-local mutable state would.
// See CameraMap.tsx's markerIcons useMemo, the only caller: without this,
// every camera got a brand-new L.divIcon (a real DOM rebuild via Leaflet's
// setIcon) on every render, including ones that changed nothing about that
// specific camera.
const markerIconCache = new Map<string, L.DivIcon>();

export const getCachedMarkerIcon = (
  camera: Camera,
  isSelected: boolean,
  isOnRoute: boolean,
  isHighlighted: boolean,
  showCameraType: boolean = false
): L.DivIcon => {
  const status = (camera.connectivity_status || 'offline').toLowerCase();
  const key = `${camera.id}|${status}|${isSelected}|${isOnRoute}|${isHighlighted}|${showCameraType}`;
  let icon = markerIconCache.get(key);
  if (!icon) {
    icon = createCustomMarkerIcon(camera, isSelected, isOnRoute, isHighlighted, showCameraType);
    markerIconCache.set(key, icon);
  }
  return icon;
};

// A small chevron rotated to `bearingDeg`, placed at each leg's midpoint --
// large-scale ALPR platforms (e.g. Genetec AutoVu's ML Core) report
// "direction of travel" the same way this route does: inferred from the
// order and spacing of fixed camera reads, not continuous GPS. Framed as
// "inferred" everywhere it's shown (see CameraMap's route caption), same
// honesty the rest of this route already keeps toward an investigator
// reading it.
export const createDirectionArrowIcon = (bearingDeg: number) =>
  L.divIcon({
    html: `
      <div style="transform: rotate(${bearingDeg}deg);" class="w-4 h-4 flex items-center justify-center">
        <svg viewBox="0 0 16 16" class="w-3.5 h-3.5 drop-shadow">
          <path d="M8 1 L13 13 L8 10 L3 13 Z" fill="#93C5FD" stroke="#1E3A8A" stroke-width="0.75" />
        </svg>
      </div>
    `,
    className: 'direction-arrow-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

// Police stations previously rendered as a plain amber CircleMarker dot --
// visually identical in shape to every other dot on the map (plate
// sightings, coverage targets), so a station was only distinguishable by
// color, not shape. A pin (not a circle) with a shield glyph reads as "a
// place" rather than "an event/reading" at a glance, and the shield ties it
// to the app's own logo mark rather than inventing a new symbol. Every
// station uses the exact same icon (no per-station state, unlike a
// camera's online/offline/selected variants), so this is a plain shared
// constant instead of a factory re-built on every render.
export const POLICE_STATION_ICON = L.divIcon({
  html: `
    <svg viewBox="0 0 26 34" class="w-7 h-7 drop-shadow-md">
      <path d="M13 0C5.8 0 0 5.8 0 13c0 9.5 13 21 13 21s13-11.5 13-21C26 5.8 20.2 0 13 0z" fill="#FBBF24" stroke="#78350F" stroke-width="1.5" />
      <path d="M13 6.4 L17.6 8.1 V12.6 C17.6 15.9 13 18.2 13 18.2 C13 18.2 8.4 15.9 8.4 12.6 V8.1 Z" fill="#78350F" />
    </svg>
  `,
  className: 'police-station-marker',
  iconSize: [26, 34],
  iconAnchor: [13, 34],
  popupAnchor: [0, -30],
});

// The animated marker that sweeps along a vehicle's inferred route
// (CameraMap's VehicleTraceMarker) — a small glowing dot, not a directional
// icon; direction is now shown separately via createDirectionArrowIcon above.
export const createVehicleTraceIcon = () =>
  L.divIcon({
    html: `
      <div class="relative flex items-center justify-center w-4 h-4">
        <div class="absolute inset-0 rounded-full bg-blue-400/40 animate-ping"></div>
        <div class="relative w-2.5 h-2.5 rounded-full bg-blue-300 border border-white shadow-[0_0_6px_2px_rgba(96,165,250,0.9)]"></div>
      </div>
    `,
    className: 'vehicle-trace-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });