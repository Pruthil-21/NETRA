import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AddCameraModal from '@/components/registry/AddCameraModal';
import { circlesService } from '@/services/circlesService';

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: vi.fn() },
}));
vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ addCamera: vi.fn(), importCameras: vi.fn() }),
}));

describe('AddCameraModal circle dropdown', () => {
  it('shows a Circle dropdown populated from circlesService', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Circle')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Anand — APC Circle')).toBeInTheDocument());
  });

  it('shows all circles unfiltered since a manually-added camera has no known district', async () => {
    (circlesService.listCircles as any).mockResolvedValue([
      { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'Junagadh Circle', district: 'Junagadh', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Anand — APC Circle')).toBeInTheDocument());
    expect(screen.getByText('Junagadh — Junagadh Circle')).toBeInTheDocument();
  });
});
