import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CameraInfoOverlay } from '@/components/overlay/CameraInfoOverlay';
import type { Camera } from '@/types/camera';

vi.mock('@/components/map/MapPopupPreviewPlayer', () => ({
  default: () => <div data-testid="preview-player" />,
}));

// Every test renders a camera, which now fires useCameraHealth's fetch --
// stub it globally so tests are deterministic instead of hitting a real
// network call. Individual tests override this via vi.stubGlobal when they
// need to assert on the health panel's contents.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CAMERA: Camera = {
  id: 42, name: 'Junagadh Gate Cam', dept: 'Anand', lat: 22.5, long: 72.9,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational',
  rtsp_url: '', circle_id: 7,
};

describe('CameraInfoOverlay', () => {
  it('renders nothing when camera is null', () => {
    const { container } = render(<CameraInfoOverlay camera={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders camera details and the live preview player when camera is set', () => {
    render(<CameraInfoOverlay camera={CAMERA} circleName="APC Circle" onClose={() => {}} />);
    expect(screen.getByText('Junagadh Gate Cam')).toBeInTheDocument();
    expect(screen.getByText('APC Circle')).toBeInTheDocument();
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.getByTestId('preview-player')).toBeInTheDocument();
  });

  it('shows the SNMP monitor\'s device health metrics when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'cam42', name: 'cam42', status: 'online', reachable: true,
            snmp_mode: 'mock', snmp_state: 'simulated', last_checked_at: '2026-09-05T00:00:00Z',
            metrics: { cpu_percent: 42, memory_percent: 55, network_mbps: 12.3, temperature_celsius: 48 },
          }),
        } as Response)
      )
    );
    render(<CameraInfoOverlay camera={CAMERA} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('42%')).toBeInTheDocument());
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('12.3 Mbps')).toBeInTheDocument();
    expect(screen.getByText('48°C')).toBeInTheDocument();
  });

  it('shows "Unassigned" when circleName is not provided', () => {
    render(<CameraInfoOverlay camera={CAMERA} onClose={() => {}} />);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('calls onClose when the close button or the scrim is clicked', () => {
    const onClose = vi.fn();
    render(<CameraInfoOverlay camera={CAMERA} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Regression coverage for the open/close/reopen flicker loop: the overlay
  // renders fixed inset-0 over the tile/marker it opened on top of, so that
  // tile's own mouseleave fires as soon as the overlay appears. Without a way
  // for the caller to know "the cursor is now over the overlay, not gone
  // entirely," the tile's hover-grace timer would close this overlay right
  // back out, only for the tile to "re-enter" once it closes and reopen a
  // moment later. These two handlers are how the caller (app/page.tsx,
  // app/map/page.tsx) tracks that and skips the spurious clear.
  it('fires onMouseEnterOverlay when the cursor enters and onMouseLeaveOverlay + onClose when it leaves', () => {
    const onClose = vi.fn();
    const onMouseEnterOverlay = vi.fn();
    const onMouseLeaveOverlay = vi.fn();
    render(
      <CameraInfoOverlay
        camera={CAMERA}
        onClose={onClose}
        onMouseEnterOverlay={onMouseEnterOverlay}
        onMouseLeaveOverlay={onMouseLeaveOverlay}
      />
    );

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseEnter(dialog);
    expect(onMouseEnterOverlay).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(dialog);
    expect(onMouseLeaveOverlay).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Simulates the exact sequence a real hover produces: the source tile's own
  // grace timer fires a "clear" (would-be onClose) while the overlay is still
  // being hovered -- a caller gating that on "is the mouse over the overlay
  // right now" (set/cleared by these two props) must not let it close.
  it('lets a caller suppress a stale hover-grace clear while the overlay itself is hovered', () => {
    let hoveredCameraId: number | null = CAMERA.id;
    const overlayHoveredRef = { current: false };
    const setHoveredCameraId = (id: number | null) => {
      hoveredCameraId = id;
    };
    // Mirrors app/page.tsx's handleHoverEnd: only clears if the overlay isn't
    // the thing currently under the cursor.
    const handleHoverEndFromTile = (id: number) => {
      if (hoveredCameraId === id && !overlayHoveredRef.current) setHoveredCameraId(null);
    };

    const { rerender } = render(
      <CameraInfoOverlay
        camera={CAMERA}
        onClose={() => setHoveredCameraId(null)}
        onMouseEnterOverlay={() => {
          overlayHoveredRef.current = true;
        }}
        onMouseLeaveOverlay={() => {
          overlayHoveredRef.current = false;
        }}
      />
    );

    fireEvent.mouseEnter(screen.getByRole('dialog'));
    expect(overlayHoveredRef.current).toBe(true);

    // The tile's own grace timer elapses next (this is the spurious signal).
    handleHoverEndFromTile(CAMERA.id);
    expect(hoveredCameraId).toBe(CAMERA.id); // NOT cleared -- overlay is still hovered.

    rerender(
      <CameraInfoOverlay
        camera={CAMERA}
        onClose={() => setHoveredCameraId(null)}
        onMouseEnterOverlay={() => {
          overlayHoveredRef.current = true;
        }}
        onMouseLeaveOverlay={() => {
          overlayHoveredRef.current = false;
        }}
      />
    );

    // Cursor genuinely leaves the overlay -- this is the real close signal.
    fireEvent.mouseLeave(screen.getByRole('dialog'));
    expect(hoveredCameraId).toBe(null);
  });
});
