import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScaleCameraList } from '@/components/scale/ScaleCameraList';

function makeCameras(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, name: `SYN-CAM-${i + 1}`, dept: 'Test District', lat: 22, long: 72,
    camera_type: 'ip', ownership: 'synthetic-scale-demo', connectivity_status: 'online',
    storage_type: 'nvr', retention_days: 15, health_status: 'operational', rtsp_url: null,
    is_synthetic: true, edge_node_id: 1,
  }));
}

// jsdom does no real layout, so every element's offsetHeight/offsetWidth is
// 0 -- @tanstack/react-virtual treats a 0 measured container size as "not
// yet measured" and returns an empty virtual-items range regardless of
// ResizeObserver availability. Stubbing these two prototype accessors gives
// the virtualizer a non-zero viewport to compute a real range against;
// restored after each test so it doesn't leak into other test files sharing
// this process.
let offsetHeightDescriptor: PropertyDescriptor | undefined;
let offsetWidthDescriptor: PropertyDescriptor | undefined;

describe('ScaleCameraList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    offsetWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  });

  afterEach(() => {
    if (offsetHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor);
    if (offsetWidthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidthDescriptor);
  });

  it('does not render every row into the DOM for a large page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: makeCameras(200), next_cursor: null }) })
    );

    render(<ScaleCameraList onSelectCamera={() => {}} />);

    await waitFor(() => expect(screen.getAllByText(/SYN-CAM-/).length).toBeGreaterThan(0));
    // A virtualized list renders far fewer DOM rows than the full page size --
    // this is the whole point of the requirement.
    expect(screen.getAllByText(/SYN-CAM-/).length).toBeLessThan(200);
  });

  it('shows an empty state when the page has no cameras', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) }));
    render(<ScaleCameraList onSelectCamera={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no cameras/i)).toBeInTheDocument());
  });

  it('loads a second page via next_cursor once loadMore is invoked', async () => {
    // Exercises the actual pagination chaining logic directly rather than
    // trying to simulate real virtualizer scroll physics in jsdom (which
    // has no real layout engine) -- ScaleCameraList exposes loadMore via
    // the onLoadMoreReady callback specifically so this is testable.
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cameras: makeCameras(200), next_cursor: 200 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          cameras: Array.from({ length: 50 }, (_, i) => ({ ...makeCameras(1)[0], id: 200 + i, name: `SYN-CAM-${200 + i}` })),
          next_cursor: null,
        }),
      });
    vi.stubGlobal('fetch', fetchSpy);

    let loadMore: (() => void) | undefined;
    render(
      <ScaleCameraList
        onSelectCamera={() => {}}
        onLoadMoreReady={(fn) => {
          loadMore = fn;
        }}
      />
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    loadMore?.();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const secondCallUrl = fetchSpy.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('cursor=200');
  });
});
