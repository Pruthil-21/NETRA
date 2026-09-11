import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DistrictAreaTree } from '@/components/tree/DistrictAreaTree';
import { usePermissions } from '@/hooks/usePermissions';
import type { Camera } from '@/types/camera';

// The right-click menu itself is fully covered by cameraContextMenu.test.tsx
// -- this file only covers the tree's own wiring: right-click/⋮ opening it
// for the right camera, RBAC gating reaching all the way down, and the
// Properties/Configure actions actually mounting their modals.
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));
vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ applyCameraUpdate: vi.fn(), removeCamera: vi.fn() }),
}));
vi.mock('@/components/registry/CameraDetailDrawer', () => ({
  default: ({ camera }: { camera: Camera }) => <div>{camera.name} drawer contents</div>,
}));

const AREAS = [
  { id: 1, name: 'APC Area', district: 'Anand', district_id: 1, village: 'Village', taluka: 'Taluka', village_id: 1, created_at: '2026-01-01T00:00:00Z' },
];

const CAMERAS: any[] = [
  { id: 101, name: 'Camera 01', dept: 'Anand', area_id: 1, lat: 22.5, long: 72.9, camera_type: 'Bullet', ownership: 'Anand Police', connectivity_status: 'online', storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '' },
];

function mockPermissions(canManage: boolean, scope?: { scopeType: string; scopeValue: string }) {
  (usePermissions as any).mockReturnValue({
    has: (p: string) => (canManage ? p === 'manage_cameras' : false),
    scopeType: scope?.scopeType ?? null,
    scopeValue: scope?.scopeValue ?? null,
  });
}

describe('DistrictAreaTree right-click camera menu', () => {
  beforeEach(() => {
    mockPermissions(false);
  });

  it('opens the menu for the right camera on right-click', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    expect(screen.getByRole('menu', { name: 'Camera 01 actions' })).toBeInTheDocument();
  });

  it('also opens via the hover "⋮" trigger, for devices with no right-click', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText('Camera 01 actions'));
    expect(screen.getByRole('menu', { name: 'Camera 01 actions' })).toBeInTheDocument();
  });

  it('disables Configure without manage_cameras', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    expect(screen.getByText('Configure…').closest('button')).toBeDisabled();
  });

  it('enables Configure and opens ConfigureCameraModal when manage_cameras is granted', () => {
    mockPermissions(true);
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    const configureBtn = screen.getByText('Configure…').closest('button')!;
    expect(configureBtn).not.toBeDisabled();
    fireEvent.click(configureBtn);
    expect(screen.getByText('Configure — Camera 01')).toBeInTheDocument();
  });

  it('disables Configure with an outside-your-district tooltip when manage_cameras is granted but the camera is outside the officer\'s district scope', () => {
    mockPermissions(true, { scopeType: 'district', scopeValue: 'Vadodara' });
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    const configureBtn = screen.getByText('Configure…').closest('button')!;
    expect(configureBtn).toBeDisabled();
    expect(configureBtn.title).toBe('This camera is outside your district');
  });

  it('enables Configure when manage_cameras is granted and the camera is inside the officer\'s district scope', () => {
    mockPermissions(true, { scopeType: 'district', scopeValue: 'Anand' });
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    const configureBtn = screen.getByText('Configure…').closest('button')!;
    expect(configureBtn).not.toBeDisabled();
  });

  it('opens the Properties modal with the drawer content', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    fireEvent.click(screen.getByText('Properties'));
    expect(screen.getByText('Camera 01 drawer contents')).toBeInTheDocument();
  });

  it('does not show Play without onPlayCamera (Map/Archive)', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    expect(screen.queryByText('Play')).not.toBeInTheDocument();
  });

  it('shows Play and calls onPlayCamera when supplied (Dashboard)', () => {
    const onPlayCamera = vi.fn();
    render(
      <DistrictAreaTree
        districts={['Anand']}
        areas={AREAS}
        cameras={CAMERAS}
        selected={null}
        onSelect={() => {}}
        onPlayCamera={onPlayCamera}
      />
    );
    fireEvent.contextMenu(screen.getByText('Camera 01'));
    fireEvent.click(screen.getByText('Play'));
    expect(onPlayCamera).toHaveBeenCalledWith(101);
  });
});
