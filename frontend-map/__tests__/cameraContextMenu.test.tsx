import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CameraContextMenu } from '@/components/registry/CameraContextMenu';
import { cameraService } from '@/services/cameraService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import type { Camera } from '@/types/camera';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

vi.mock('@/services/cameraService', () => ({
  cameraService: {
    updateCamera: vi.fn(),
    deleteCamera: vi.fn(),
  },
}));

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: vi.fn(),
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

const applyCameraUpdate = vi.fn();
const removeCamera = vi.fn();

function renderMenu(overrides: Partial<React.ComponentProps<typeof CameraContextMenu>> = {}) {
  const onClose = vi.fn();
  render(
    <CameraContextMenu
      camera={CAMERA}
      anchor={{ x: 10, y: 10 }}
      onClose={onClose}
      canManage
      onViewDetails={vi.fn()}
      onConfigure={vi.fn()}
      {...overrides}
    />
  );
  return { onClose };
}

describe('CameraContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useCameraRegistry as any).mockReturnValue({ applyCameraUpdate, removeCamera });
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('shows Play only when onPlay is supplied (Dashboard-only)', () => {
    const { unmount } = render(
      <CameraContextMenu camera={CAMERA} anchor={{ x: 0, y: 0 }} onClose={vi.fn()} canManage onViewDetails={vi.fn()} onConfigure={vi.fn()} />
    );
    expect(screen.queryByText('Play')).not.toBeInTheDocument();
    unmount();
    renderMenu({ onPlay: vi.fn() });
    expect(screen.getByText('Play')).toBeInTheDocument();
  });

  it('navigates to the alerts page filtered to this camera on "View Alerts for this Camera"', () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByText('View Alerts for this Camera'));
    expect(pushMock).toHaveBeenCalledWith('/alerts?camera=12');
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates to the archive deep link on "View Recorded Footage" and closes', () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByText('View Recorded Footage'));
    expect(pushMock).toHaveBeenCalledWith('/archive?camera=12');
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates to the map deep link on "Locate on Map"', () => {
    renderMenu();
    fireEvent.click(screen.getByText('Locate on Map'));
    expect(pushMock).toHaveBeenCalledWith('/map?camera=12');
  });

  it('calls onViewDetails on "Properties"', () => {
    const onViewDetails = vi.fn();
    const { onClose } = renderMenu({ onViewDetails });
    fireEvent.click(screen.getByText('Properties'));
    expect(onViewDetails).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('copies the camera id to the clipboard and shows transient feedback', async () => {
    renderMenu();
    fireEvent.click(screen.getByText('Copy Camera ID'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('12');
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
  });

  it('offers Copy RTSP URL only when the camera has one', () => {
    renderMenu();
    expect(screen.getByText('Copy RTSP URL')).toBeInTheDocument();
    cleanup();
    renderMenu({ camera: { ...CAMERA, rtsp_url: '' } });
    expect(screen.queryByText('Copy RTSP URL')).not.toBeInTheDocument();
  });

  it('disables Configure/Rename/Delete without manage_cameras, and clicking does nothing', () => {
    const onConfigure = vi.fn();
    renderMenu({ canManage: false, onConfigure });
    const configureBtn = screen.getByText('Configure…').closest('button')!;
    expect(configureBtn).toBeDisabled();
    fireEvent.click(configureBtn);
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it('calls onConfigure when manage_cameras is granted', () => {
    const onConfigure = vi.fn();
    const { onClose } = renderMenu({ onConfigure });
    fireEvent.click(screen.getByText('Configure…'));
    expect(onConfigure).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('renames the camera inline and applies the update locally', async () => {
    (cameraService.updateCamera as any).mockResolvedValue({ ...CAMERA, name: 'New Name' });
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('Anand Junction Cam');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(cameraService.updateCamera).toHaveBeenCalledWith(12, { name: 'New Name' }));
    await waitFor(() => expect(applyCameraUpdate).toHaveBeenCalledWith(12, { name: 'New Name' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('requires an explicit confirm before deleting, and removes the camera locally on success', async () => {
    (cameraService.deleteCamera as any).mockResolvedValue(undefined);
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByText('Delete Camera'));
    expect(cameraService.deleteCamera).not.toHaveBeenCalled();
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(cameraService.deleteCamera).toHaveBeenCalledWith(12));
    await waitFor(() => expect(removeCamera).toHaveBeenCalledWith(12));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the camera and shows an error inline when delete fails, instead of silently closing', async () => {
    (cameraService.deleteCamera as any).mockRejectedValue(new Error('Camera has active recordings'));
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByText('Delete Camera'));
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(screen.getByText('Camera has active recordings')).toBeInTheDocument());
    expect(removeCamera).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on an outside click', () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
