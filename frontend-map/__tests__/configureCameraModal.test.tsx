import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfigureCameraModal from '@/components/registry/ConfigureCameraModal';
import { cameraService } from '@/services/cameraService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';
import type { Camera } from '@/types/camera';

vi.mock('@/services/cameraService', () => ({
  cameraService: { updateCamera: vi.fn() },
}));

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: vi.fn(),
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
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
  rtsp_url: 'rtsp://example/cam12',
  stream_id: 12,
  area_id: 1,
};

const AREAS = [
  { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'North Anand Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 3, name: 'Vadodara HQ Area', district: 'Vadodara', created_at: '2026-01-01T00:00:00Z' },
] as any;

const applyCameraUpdate = vi.fn();

describe('ConfigureCameraModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useCameraRegistry as any).mockReturnValue({ applyCameraUpdate });
    (usePermissions as any).mockReturnValue({ scopeType: null, scopeValue: null });
  });

  it('prefills every field from the camera being edited', () => {
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Anand Junction Cam');
    expect(screen.getByLabelText('Ownership')).toHaveValue('Traffic Police');
    expect(screen.getByLabelText('RTSP URL')).toHaveValue('rtsp://example/cam12');
    expect(screen.getByLabelText('Retention (Days)')).toHaveValue(30);
  });

  it('sends only the fields that actually changed', async () => {
    (cameraService.updateCamera as any).mockResolvedValue({ ...CAMERA, name: 'Renamed Cam' });
    const onClose = vi.fn();
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Cam' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(cameraService.updateCamera).toHaveBeenCalledWith(12, { name: 'Renamed Cam' }));
    await waitFor(() => expect(applyCameraUpdate).toHaveBeenCalledWith(12, { name: 'Renamed Cam' }));
  });

  it('closes without writing anything when nothing actually changed', async () => {
    const onClose = vi.fn();
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={onClose} />);
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(cameraService.updateCamera).not.toHaveBeenCalled();
  });

  it('clears the area when switching to a district it doesn\'t belong to', () => {
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Area')).toHaveValue('1');
    fireEvent.change(screen.getByLabelText('District'), { target: { value: 'Vadodara' } });
    expect(screen.getByLabelText('Area')).toHaveValue('');
  });

  it('surfaces a save failure inline instead of closing', async () => {
    (cameraService.updateCamera as any).mockRejectedValue(new Error('Name already taken'));
    const onClose = vi.fn();
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duplicate Name' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(screen.getByText('Name already taken')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(applyCameraUpdate).not.toHaveBeenCalled();
  });

  it('locks the District field for a district-scoped officer', () => {
    (usePermissions as any).mockReturnValue({ scopeType: 'district', scopeValue: 'Anand' });
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={vi.fn()} />);
    expect(screen.getByLabelText('District')).toBeDisabled();
  });

  it('leaves the District field editable for a platform-scoped officer', () => {
    (usePermissions as any).mockReturnValue({ scopeType: 'platform', scopeValue: null });
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={vi.fn()} />);
    expect(screen.getByLabelText('District')).not.toBeDisabled();
  });

  it('closes on Cancel without saving', () => {
    const onClose = vi.fn();
    render(<ConfigureCameraModal camera={CAMERA} districts={['Anand', 'Vadodara']} areas={AREAS} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Should Not Save' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(cameraService.updateCamera).not.toHaveBeenCalled();
  });
});
