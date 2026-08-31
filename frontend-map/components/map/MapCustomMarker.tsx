import L from 'leaflet';
import { Camera } from '../../types/camera';

export const createCustomMarkerIcon = (camera: Camera, isSelected: boolean, isOnRoute: boolean = false) => {
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
  // still gets the louder ping ring and wins if both apply.
  const highlightRing = isSelected
    ? `<div class="absolute -inset-1.5 rounded-full border-2 border-command bg-command/20 animate-ping"></div>
       <div class="absolute -inset-1 rounded-full border-2 border-command"></div>`
    : isOnRoute
      ? `<div class="absolute -inset-1 rounded-full border-2 border-blue-400 bg-blue-400/10"></div>`
      : '';

  const html = `
    <div class="relative flex items-center justify-center w-8 h-8 ${isOnline ? 'radar-sweep' : ''}">
      ${highlightRing}
      <svg viewBox="0 0 32 32" class="w-8 h-8 drop-shadow-md">
        <circle cx="16" cy="16" r="14" fill="#05070A" stroke="${color}" stroke-width="${isSelected ? '3' : '2'}" />
        ${innerShape}
      </svg>
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

// The animated marker that sweeps along a vehicle's inferred route
// (CameraMap's VehicleTraceMarker) — a small glowing dot, not a directional
// icon, since deriving true heading between sparse camera points would be
// more precision than the "inferred, not GPS" route actually supports.
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