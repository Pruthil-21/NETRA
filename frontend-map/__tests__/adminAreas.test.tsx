// frontend-map/__tests__/adminAreas.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AreaManagementSection } from '@/app/admin/AreaManagementSection';
import { areasService } from '@/services/areasService';
import { locationsService } from '@/services/locationsService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';

vi.mock('@/services/areasService', () => ({
  areasService: { listAreas: vi.fn(), createArea: vi.fn(), deleteArea: vi.fn(), updateArea: vi.fn() },
}));
vi.mock('@/services/locationsService', () => ({
  locationsService: { listDistricts: vi.fn(), listTalukas: vi.fn(), searchVillages: vi.fn() },
}));
vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: vi.fn(),
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

function mockPermissions(canManage: boolean) {
  (usePermissions as any).mockReturnValue({ has: (p: string) => (canManage ? p === 'manage_areas' : false) });
}

const ANAND = { id: 1, name: 'Anand', lgd_code: '440' };
const VADODARA = { id: 2, name: 'Vadodara', lgd_code: '461' };
const ANAND_TALUKA = { id: 10, name: 'Anand', district_id: 1, no_lgd_data: false };
const VAV_THARAD_RAH = { id: 99, name: 'Rah', district_id: 33, no_lgd_data: true };
const APC = { id: 100, name: 'APC', taluka_id: 10, is_urban: true };

function mockCameras(cameras: { id: number; dept: string; area_id?: number | null }[]) {
  (useCameraRegistry as any).mockReturnValue({ cameras });
}

async function pick(label: string, optionText: string) {
  fireEvent.focus(screen.getByLabelText(label));
  fireEvent.click(await screen.findByText(optionText));
}

describe('AreaManagementSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCameras([]);
    mockPermissions(true);
    (locationsService.listDistricts as any).mockResolvedValue([ANAND, VADODARA]);
    (locationsService.listTalukas as any).mockResolvedValue([ANAND_TALUKA]);
    (locationsService.searchVillages as any).mockResolvedValue([APC]);
    (areasService.listAreas as any).mockResolvedValue([]);
  });

  it('cascades district -> taluka -> village and loads that village\'s areas', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AreaManagementSection districtScope={null} />);

    await pick('District', 'Anand');
    await waitFor(() => expect(locationsService.listTalukas).toHaveBeenCalledWith(1));
    await pick('Taluka', 'Anand');
    await waitFor(() => expect(locationsService.searchVillages).toHaveBeenCalledWith({ talukaId: 10 }));
    await pick('Village / Town', 'APC');

    await waitFor(() => expect(areasService.listAreas).toHaveBeenCalledWith({ villageId: 100 }));
    expect(await screen.findByText('APC Area')).toBeInTheDocument();
  });

  it('locks and pre-selects the district when districtScope is set', async () => {
    render(<AreaManagementSection districtScope="Anand" />);
    await waitFor(() => expect(screen.getByLabelText('District')).toHaveValue('Anand'));
    expect(screen.getByLabelText('District')).toBeDisabled();
  });

  it('flags a no-LGD-data taluka with a warning instead of a village list', async () => {
    (locationsService.listTalukas as any).mockResolvedValue([VAV_THARAD_RAH]);
    render(<AreaManagementSection districtScope={null} />);
    await pick('District', 'Anand');
    await pick('Taluka', 'Rah');
    expect(
      await screen.findByText(/not yet covered by our village-level reference data/i)
    ).toBeInTheDocument();
  });

  it('surfaces an error when loading districts fails', async () => {
    (locationsService.listDistricts as any).mockRejectedValue(new Error('Failed to load districts'));
    render(<AreaManagementSection districtScope={null} />);
    await waitFor(() => expect(screen.getByText(/Failed to load districts/)).toBeInTheDocument());
  });

  async function selectDownToVillage() {
    render(<AreaManagementSection districtScope={null} />);
    await pick('District', 'Anand');
    await pick('Taluka', 'Anand');
    await pick('Village / Town', 'APC');
  }

  it('disables delete and shows an explanatory tooltip when an area still has cameras assigned', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'In-Use Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    mockCameras([{ id: 5, dept: 'Anand', area_id: 1 }]);
    await selectDownToVillage();
    const deleteButton = await screen.findByLabelText('Delete In-Use Area') as HTMLButtonElement;
    expect(deleteButton).toBeDisabled();
    expect(deleteButton.title).toMatch(/1 camera still assigned/);
  });

  it('leaves delete enabled when an area has no cameras assigned', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'Empty Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    await selectDownToVillage();
    expect(await screen.findByLabelText('Delete Empty Area')).not.toBeDisabled();
  });

  it('creates a new area scoped to the selected village', async () => {
    (areasService.createArea as any).mockResolvedValue({
      id: 2, name: 'New Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z',
    });
    await selectDownToVillage();
    fireEvent.change(screen.getByLabelText('Add area to selected village'), { target: { value: 'New Area' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() =>
      expect(areasService.createArea).toHaveBeenCalledWith({ name: 'New Area', village_id: 100 })
    );
  });

  it('supports inline rename of an area', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'Old Name', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    (areasService.updateArea as any).mockResolvedValue({
      id: 1, name: 'New Name', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z',
    });
    await selectDownToVillage();
    await waitFor(() => expect(screen.getByText('Old Name')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Edit Old Name'));
    fireEvent.change(screen.getByLabelText('Rename Old Name'), { target: { value: 'New Name' } });

    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'New Name', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    fireEvent.click(screen.getByLabelText('Save name for Old Name'));

    expect(areasService.updateArea).toHaveBeenCalledWith(1, { name: 'New Name' });
    await waitFor(() => expect(screen.getByText('New Name')).toBeInTheDocument());
  });

  it('disables Add/Edit/Delete with an explanatory tooltip when manage_areas is not granted', async () => {
    mockPermissions(false);
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'Some Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand', district_id: 1, created_at: '2026-01-01T00:00:00Z' },
    ]);
    await selectDownToVillage();

    const editButton = await screen.findByLabelText('Edit Some Area') as HTMLButtonElement;
    const deleteButton = screen.getByLabelText('Delete Some Area') as HTMLButtonElement;
    const addButton = screen.getByRole('button', { name: /add/i }) as HTMLButtonElement;

    expect(editButton).toBeDisabled();
    expect(editButton.title).toBe('Requires the Manage Areas permission');
    expect(deleteButton).toBeDisabled();
    expect(deleteButton.title).toBe('Requires the Manage Areas permission');
    expect(addButton).toBeDisabled();
  });
});
