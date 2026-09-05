// frontend-map/__tests__/adminCircles.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CircleManagementSection } from '@/app/admin/CircleManagementSection';
import { circlesService } from '@/services/circlesService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: vi.fn(), createCircle: vi.fn(), deleteCircle: vi.fn(), updateCircle: vi.fn() },
}));
vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: vi.fn(),
}));

function mockCameras(cameras: { id: number; dept: string; circle_id?: number | null }[]) {
  (useCameraRegistry as any).mockReturnValue({ cameras });
}

describe('CircleManagementSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCameras([]);
  });

  it('groups circles by district', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'Vadodara Circle', district: 'Vadodara', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<CircleManagementSection districtScope={null} />);
    await waitFor(() => expect(screen.getByText('APC Circle')).toBeInTheDocument());
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.getByText('Vadodara')).toBeInTheDocument();
  });

  it('only shows the scoped district when districtScope is set', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('APC Circle')).toBeInTheDocument());
    expect(screen.queryByLabelText(/add circle to a different district/i)).not.toBeInTheDocument();
  });

  it('surfaces an error when the initial circles load fails', async () => {
    (circlesService.listCircles as any).mockRejectedValue(new Error('Failed to fetch circles: HTTP 500'));
    render(<CircleManagementSection districtScope={null} />);
    await waitFor(() => expect(screen.getByText(/Failed to fetch circles/)).toBeInTheDocument());
  });

  it('shows a district with zero circles so a super_admin can bootstrap the first one', async () => {
    // No circles exist anywhere yet, but the camera registry already knows
    // about a district -- that district must still get a row (with an "Add"
    // control), otherwise there is no way to ever create its first circle.
    (circlesService.listCircles as any).mockResolvedValue([]);
    mockCameras([{ id: 101, dept: 'Junagadh', circle_id: null }]);
    render(<CircleManagementSection districtScope={null} />);
    await waitFor(() => expect(screen.getByText('Junagadh')).toBeInTheDocument());
    expect(screen.getByLabelText('Add area to Junagadh')).toBeInTheDocument();
    expect(screen.getByText('No areas yet')).toBeInTheDocument();
  });

  it('disables delete and shows an explanatory tooltip when a circle still has cameras assigned', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'In-Use Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    mockCameras([{ id: 5, dept: 'Anand', circle_id: 1 }]);
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('In-Use Circle')).toBeInTheDocument());
    const deleteButton = screen.getByLabelText('Delete In-Use Circle') as HTMLButtonElement;
    expect(deleteButton).toBeDisabled();
    expect(deleteButton.title).toMatch(/1 camera still assigned/);
  });

  it('leaves delete enabled when a circle has no cameras assigned', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'Empty Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('Empty Circle')).toBeInTheDocument());
    expect(screen.getByLabelText('Delete Empty Circle')).not.toBeDisabled();
  });

  it('shows an error if the backend rejects a delete despite a locally zero camera count (e.g. stale count)', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'Race Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    (circlesService.deleteCircle as any).mockRejectedValue(new Error('Failed to delete circle: HTTP 400'));
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('Race Circle')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Delete Race Circle'));
    await waitFor(() => expect(screen.getByText(/Failed to delete circle/)).toBeInTheDocument());
  });

  it('supports inline rename of a circle', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'Old Name', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    (circlesService.updateCircle as any).mockResolvedValue({
      id: 1, name: 'New Name', district: 'Anand', created_at: '2026-01-01T00:00:00Z',
    });
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('Old Name')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Edit Old Name'));
    const input = screen.getByLabelText('Rename Old Name');
    fireEvent.change(input, { target: { value: 'New Name' } });

    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'New Name', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    fireEvent.click(screen.getByLabelText('Save name for Old Name'));

    expect(circlesService.updateCircle).toHaveBeenCalledWith(1, { name: 'New Name' });
    await waitFor(() => expect(screen.getByText('New Name')).toBeInTheDocument());
  });
});
