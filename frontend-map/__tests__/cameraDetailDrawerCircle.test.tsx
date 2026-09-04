import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import { circlesService } from '@/services/circlesService';
import { cameraService } from '@/services/cameraService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';
import type { Camera } from '@/types/camera';

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: vi.fn() },
}));
vi.mock('@/services/cameraService', () => ({
  cameraService: { updateCameraCircle: vi.fn() },
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
  rtsp_url: '',
  circle_id: 1,
};

const CIRCLES = [
  { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'North Anand Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 3, name: 'Vadodara HQ Circle', district: 'Vadodara', created_at: '2026-01-01T00:00:00Z' },
];

function mockPermissions(canManageCameras: boolean) {
  (usePermissions as any).mockReturnValue({
    role: canManageCameras ? 'district_command' : 'auditor',
    scopeValue: null,
    permissions: canManageCameras ? ['manage_cameras'] : [],
    loading: false,
    has: (p: string) => (canManageCameras ? p === 'manage_cameras' : false),
  });
}

describe('CameraDetailDrawer circle assignment control', () => {
  const applyCameraCircleAssignment = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ camera_id: 12, current_status: 'online', windows: [] }) })
    );
    (useCameraRegistry as any).mockReturnValue({
      updateCameraConnectivity: vi.fn(),
      applyCameraCircleAssignment,
    });
    (circlesService.listCircles as any).mockResolvedValue(CIRCLES);
    applyCameraCircleAssignment.mockClear();
  });

  it('loads circles and filters the options to the camera\'s own district', async () => {
    mockPermissions(true);
    render(<CameraDetailDrawer camera={CAMERA} />);

    await waitFor(() => expect(screen.getByLabelText('Circle')).toBeInTheDocument());
    expect(screen.getByText('APC Circle')).toBeInTheDocument();
    expect(screen.getByText('North Anand Circle')).toBeInTheDocument();
    expect(screen.queryByText('Vadodara HQ Circle')).not.toBeInTheDocument();
  });

  it('calls updateCameraCircle and reflects the assignment locally on success', async () => {
    mockPermissions(true);
    (cameraService.updateCameraCircle as any).mockResolvedValue({ ...CAMERA, circle_id: 2 });
    render(<CameraDetailDrawer camera={CAMERA} />);

    await waitFor(() => expect(screen.getByLabelText('Circle')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Circle'), { target: { value: '2' } });

    await waitFor(() => expect(cameraService.updateCameraCircle).toHaveBeenCalledWith(12, 2));
    await waitFor(() => expect(applyCameraCircleAssignment).toHaveBeenCalledWith(12, 2));
  });

  it('hides the edit control and shows read-only text for a user without manage_cameras', async () => {
    mockPermissions(false);
    render(<CameraDetailDrawer camera={CAMERA} />);

    await waitFor(() => expect(screen.getByText('APC Circle')).toBeInTheDocument());
    expect(screen.queryByLabelText('Circle')).not.toBeInTheDocument();
  });

  it('surfaces a request failure inline instead of swallowing it', async () => {
    mockPermissions(true);
    (cameraService.updateCameraCircle as any).mockRejectedValue(
      new Error('Circle belongs to a different district than this camera')
    );
    render(<CameraDetailDrawer camera={CAMERA} />);

    await waitFor(() => expect(screen.getByLabelText('Circle')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Circle'), { target: { value: '2' } });

    await waitFor(() =>
      expect(screen.getByText('Circle belongs to a different district than this camera')).toBeInTheDocument()
    );
    expect(applyCameraCircleAssignment).not.toHaveBeenCalled();
  });
});
