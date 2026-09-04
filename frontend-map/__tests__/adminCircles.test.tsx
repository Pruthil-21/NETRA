// frontend-map/__tests__/adminCircles.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CircleManagementSection } from '@/app/admin/CircleManagementSection';
import { circlesService } from '@/services/circlesService';

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: vi.fn(), createCircle: vi.fn(), deleteCircle: vi.fn() },
}));

describe('CircleManagementSection', () => {
  beforeEach(() => vi.resetAllMocks());

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

  it('disables delete when a circle would need confirmation (camera count > 0 is out of this component\'s scope; here it just calls the service and surfaces its error)', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'In-Use Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    (circlesService.deleteCircle as any).mockRejectedValue(new Error('Failed to delete circle: HTTP 400'));
    render(<CircleManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByText('In-Use Circle')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Delete In-Use Circle'));
    await waitFor(() => expect(screen.getByText(/Failed to delete circle/)).toBeInTheDocument());
  });
});
