// frontend-map/__tests__/scalePage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScaleDemoPage from '@/app/scale/page';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  Marker: () => null,
  // getZoom must be present and >= CLUSTER_ONLY_MIN_ZOOM (9): BoundsWatcher's
  // mount effect calls map.getZoom() unconditionally (a missing mock method
  // throws immediately, failing every test in this file before any assertion
  // runs), and a zoom below the threshold routes ScaleMap through the
  // district-summary branch instead of listPage -- which always sets
  // cameras to [].
  useMap: () => ({ getBounds: () => ({ getSouth: () => 20, getNorth: () => 24, getWest: () => 68, getEast: () => 74 }), getZoom: () => 12, on: vi.fn(), off: vi.fn() }),
  useMapEvents: () => null,
}));
vi.mock('@/components/map/MarkerClusterGroup', () => ({
  MarkerClusterGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('ScaleDemoPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a degraded-service banner when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<ScaleDemoPage />);
    await waitFor(() => expect(screen.getByText(/Registry backend is unreachable/i)).toBeInTheDocument());
  });
});
