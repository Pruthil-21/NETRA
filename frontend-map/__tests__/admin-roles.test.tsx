// frontend-map/__tests__/admin-roles.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import AdminPage from '../app/admin/page';
import { adminService } from '../services/adminService';

vi.mock('../services/adminService');
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: ['manage_users_roles', 'manage_roles'], loading: false }),
}));

describe('Role Permissions section (super_admin)', () => {
  beforeEach(() => {
    (adminService.listOfficers as any).mockResolvedValue([]);
    (adminService.getRoles as any).mockResolvedValue([
      { name: 'station_officer', display_name: 'Station Officer', hierarchy_level: 3, permissions: ['view_live_feeds', 'search_vehicles'] },
    ]);
    (adminService.updateRolePermissions as any).mockResolvedValue({
      name: 'station_officer',
      display_name: 'Station Officer',
      hierarchy_level: 3,
      permissions: ['view_live_feeds', 'search_vehicles', 'manage_cameras'],
    });
  });

  it('shows the role and its current permissions', async () => {
    render(<AdminPage />);
    expect(await screen.findByText('Role Permissions')).toBeInTheDocument();
    expect(screen.getByText('Station Officer')).toBeInTheDocument();
  });

  it('saves an updated permission set for the role, with the typed reason code', async () => {
    render(<AdminPage />);
    const checkbox = await screen.findByLabelText('manage_cameras');
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText(/reason code/i), { target: { value: 'SCOPE_REDUCTION' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(adminService.updateRolePermissions).toHaveBeenCalledWith(
        'station_officer',
        expect.arrayContaining(['view_live_feeds', 'search_vehicles', 'manage_cameras']),
        'SCOPE_REDUCTION',
      ),
    );
  });

  it('omits the reason code when the field is left blank', async () => {
    render(<AdminPage />);
    const checkbox = await screen.findByLabelText('manage_cameras');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(adminService.updateRolePermissions).toHaveBeenCalledWith(
        'station_officer',
        expect.arrayContaining(['view_live_feeds', 'search_vehicles', 'manage_cameras']),
        undefined,
      ),
    );
  });
});

describe('Role Permissions section (district_command)', () => {
  it('does not render for a user without manage_roles', async () => {
    vi.resetModules();
    vi.doMock('../hooks/usePermissions', () => ({
      usePermissions: () => ({ permissions: ['manage_users_roles'], loading: false }),
    }));
    const { default: AdminPageNoRoleEdit } = await import('../app/admin/page');
    const { adminService: freshAdminService } = await import('../services/adminService');
    (freshAdminService.listOfficers as any).mockResolvedValue([]);
    render(<AdminPageNoRoleEdit />);
    await waitFor(() => expect(freshAdminService.listOfficers).toHaveBeenCalled());
    expect(screen.queryByText('Role Permissions')).not.toBeInTheDocument();
  });
});
