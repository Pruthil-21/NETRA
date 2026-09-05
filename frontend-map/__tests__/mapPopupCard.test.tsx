import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CameraMap } from '@/components/map/CameraMap';
import { Camera } from '@/types/camera';

const CAMERA: Camera = {
  id: 1, name: 'Test Cam', dept: 'Traffic Police', lat: 23, long: 72,
  camera_type: 'ANPR', ownership: 'Test', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational',
  rtsp_url: '',
};

// CameraMap no longer opens a Leaflet Popup/MapPopupCard on hover (Task 11) --
// it reports the hovered camera id up to the caller instead, which is the map
// page's job to feed into the shared, portal-rendered CameraInfoOverlay (same
// component the dashboard uses). This isolates exactly that reporting contract
// without needing a real Leaflet map: MapContainer/Marker/etc. are stubbed out
// (mirrors ScaleMap.test.tsx's own react-leaflet mock), since 'leaflet' itself
// is globally mocked down to divIcon/latLngBounds stubs in vitest.setup.ts and
// can't back a real react-leaflet render in jsdom.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  Marker: ({ eventHandlers }: { eventHandlers?: { click?: () => void; mouseover?: () => void; mouseout?: () => void } }) => (
    <button
      type="button"
      aria-label="Camera marker"
      onClick={eventHandlers?.click}
      onMouseOver={eventHandlers?.mouseover}
      onMouseOut={eventHandlers?.mouseout}
    />
  ),
  Popup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => null,
  CircleMarker: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  useMap: () => ({ flyTo: vi.fn(), flyToBounds: vi.fn(), getZoom: () => 10 }),
}));
vi.mock('@/components/map/MarkerClusterGroup', () => ({
  MarkerClusterGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('CameraMap hover reporting (replaces the old Popup/MapPopupCard hover path)', () => {
  it('hovering a marker (after the hold delay) reports that camera to onHoverChange for the shared info overlay', () => {
    vi.useFakeTimers();
    const onHoverChange = vi.fn();
    render(
      <CameraMap
        cameras={[CAMERA]}
        selectedCamera={null}
        onSelectCamera={() => {}}
        onHoverChange={onHoverChange}
      />
    );

    fireEvent.mouseOver(screen.getByRole('button', { name: /camera marker/i }));
    vi.advanceTimersByTime(2000);

    expect(onHoverChange).toHaveBeenCalledWith(CAMERA.id);
    vi.useRealTimers();
  });
});
