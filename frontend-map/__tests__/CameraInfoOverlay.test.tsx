import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CameraInfoOverlay } from '@/components/overlay/CameraInfoOverlay';
import type { Camera } from '@/types/camera';

vi.mock('@/components/map/MapPopupPreviewPlayer', () => ({
  default: () => <div data-testid="preview-player" />,
}));

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
});
