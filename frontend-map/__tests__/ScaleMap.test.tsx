import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScaleMap } from '@/components/scale/ScaleMap';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="map-container">{children}</div>,
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
  MarkerClusterGroup: ({ children }: { children: React.ReactNode }) => <div data-testid="cluster-group">{children}</div>,
}));

describe('ScaleMap', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches only the current bounding box, not the whole registry', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) });
    vi.stubGlobal('fetch', fetchSpy);

    render(<ScaleMap onSelectCamera={() => {}} />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('min_lat=');
    expect(calledUrl).toContain('max_lat=');
  });

  it('renders inside a cluster group', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) }));
    render(<ScaleMap onSelectCamera={() => {}} />);
    expect(await screen.findByTestId('cluster-group')).toBeInTheDocument();
  });

  it('reports interaction timing after a bounds-change fetch settles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) }));
    const onInteraction = vi.fn();
    render(<ScaleMap onSelectCamera={() => {}} onInteraction={onInteraction} />);
    await waitFor(() => expect(onInteraction).toHaveBeenCalledWith('map-bounds-change', expect.any(Number)));
  });

  it('discards a stale response that resolves after a newer request', async () => {
    // Simulates the exact race: an old, slow request resolves AFTER a
    // newer, faster one -- the map must keep the newer data, not overwrite
    // it with the stale response. Visible via the camera-count testid the
    // component renders (Step 3), not just counting fetch calls.
    let resolveStale: (value: unknown) => void = () => {};
    const staleResponse = new Promise((resolve) => {
      resolveStale = resolve;
    });
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          // First request: hangs until resolveStale() is called below.
          return staleResponse.then(() => ({
            ok: true,
            json: async () => ({
              cameras: Array.from({ length: 3 }, (_, i) => ({ id: i, name: `Stale ${i}`, dept: 'D', lat: 22, long: 72, is_synthetic: true })),
              next_cursor: null,
            }),
          }));
        }
        // Second request: resolves immediately.
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cameras: Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, name: `Fresh ${i}`, dept: 'D', lat: 22, long: 72, is_synthetic: true })),
            next_cursor: null,
          }),
        });
      })
    );

    const { rerender } = render(<ScaleMap onSelectCamera={() => {}} />);
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));

    // The mocked useMap() above returns a brand-new object every call, so a
    // plain rerender changes BoundsWatcher's effect dependency ([map, ...])
    // and re-fires onBoundsChange -- a real bounds change would do the same
    // via moveend/zoomend, this is just how to trigger a second one
    // deterministically against this file's own react-leaflet mock.
    rerender(<ScaleMap onSelectCamera={() => {}} />);
    await waitFor(() => expect(callCount).toBe(2));

    // Now let the stale first request finally resolve.
    resolveStale(undefined);

    await waitFor(() => {
      expect(screen.getByTestId('scale-map-camera-count').textContent).toBe('5'); // the fresh count, never 3
    });
  });
});
