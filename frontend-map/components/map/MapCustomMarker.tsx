import L from 'leaflet';
import { Camera } from '../../types/camera';

export const createCustomMarkerIcon = (camera: Camera, isSelected: boolean) => {
  const status = ((camera as any).status || (camera as any).connectivity || 'offline').toLowerCase();
  const isOnline = status === 'online';
  const color = isOnline ? '#10B981' : '#EF4444';
  const pulseClass = isSelected ? 'animate-pulse' : '';

  // Online = solid circle; Offline = distinct strike diamond for accessibility
  const innerShape = isOnline
    ? `<circle cx="16" cy="16" r="5" fill="${color}" />`
    : `<rect x="11" y="11" width="10" height="10" transform="rotate(45 16 16)" fill="none" stroke="${color}" stroke-width="2.5" />
       <line x1="12" y1="12" x2="20" y2="20" stroke="${color}" stroke-width="2" />`;

  const html = `
    <div class="relative flex items-center justify-center w-8 h-8 ${pulseClass}">
      ${
        isSelected
          ? `<div class="absolute -inset-1.5 rounded-full border-2 border-blue-400 bg-blue-500/20 animate-ping"></div>
             <div class="absolute -inset-1 rounded-full border-2 border-blue-400"></div>`
          : ''
      }
      <svg viewBox="0 0 32 32" class="w-8 h-8 drop-shadow-md">
        <circle cx="16" cy="16" r="14" fill="#0F172A" stroke="${color}" stroke-width="${isSelected ? '3' : '2'}" />
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