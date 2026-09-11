import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CameraDetailModal from '@/components/registry/CameraDetailModal';
import type { Camera } from '@/types/camera';

// CameraDetailDrawer's own health/uptime/recording-status behavior is
// covered by its own tests (cameraDetailDrawer*.test.tsx) -- this file only
// covers what CameraDetailModal itself adds: the modal chrome around it
// (title, close button, backdrop-click-to-close), reachable from any page's
// right-click "Properties" action rather than only Map/Search's own
// bottom-drawer host.
vi.mock('@/components/registry/CameraDetailDrawer', () => ({
  default: ({ camera }: { camera: Camera }) => <div data-testid="drawer-stub">{camera.name} drawer contents</div>,
}));

const CAMERA: Camera = {
  id: 12,
  name: 'Anand Junction Cam',
  dept: 'Anand',
  lat: 22.56,
  long: 72.94,
  camera_type: 'Bullet',
  ownership: 'Traffic Police',
  connectivity_status: 'online',
  storage_type: 'Cloud',
  retention_days: 30,
  health_status: 'operational',
  rtsp_url: '',
};

describe('CameraDetailModal', () => {
  it('shows the camera name as the title and renders the drawer inside it', () => {
    render(<CameraDetailModal camera={CAMERA} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Anand Junction Cam drawer contents')).toBeInTheDocument();
  });

  it('closes on the close button', () => {
    const onClose = vi.fn();
    render(<CameraDetailModal camera={CAMERA} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a backdrop click but not a click inside the panel', () => {
    const onClose = vi.fn();
    render(<CameraDetailModal camera={CAMERA} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('drawer-stub'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });
});
