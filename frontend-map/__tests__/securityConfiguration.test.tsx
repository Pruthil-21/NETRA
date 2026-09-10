// frontend-map/__tests__/securityConfiguration.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import AdminPage from '../app/admin/page';
import { adminService } from '../services/adminService';

vi.mock('../services/adminService');
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: ['manage_users_roles', 'manage_roles'], loading: false }),
}));

const STATION_OFFICER_ROLE = {
  id: 3, name: 'station_officer', display_name: 'Station Officer', hierarchy_level: 3,
  can_delegate_admin: false, parent_role_id: null, is_active: true, is_system: true, duty_ids: [],
  permissions: ['view_live_feeds', 'search_vehicles'],
};

describe('Security Configuration (super_admin)', () => {
  beforeEach(() => {
    (adminService.listOfficers as any).mockResolvedValue([]);
    (adminService.getRoles as any).mockResolvedValue([STATION_OFFICER_ROLE]);
    (adminService.updateRolePermissions as any).mockResolvedValue({
      ...STATION_OFFICER_ROLE,
      permissions: ['view_live_feeds', 'search_vehicles', 'manage_cameras'],
    });
  });

  it('shows the role and lets it be expanded to see its current permissions', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /security configuration/i }));
    expect(await screen.findByText('Station Officer')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand Station Officer'));
    expect(await screen.findByText('View Live Feeds')).toBeInTheDocument();
    expect(screen.getByText('Search Vehicles')).toBeInTheDocument();
  });

  it('assigns an additional permission to a role, with a typed reason code', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /security configuration/i }));
    await screen.findByText('Station Officer');

    fireEvent.click(screen.getByRole('button', { name: /assign permissions/i }));
    fireEvent.click(await screen.findByRole('button', { name: /manage cameras/i }));
    fireEvent.change(screen.getByLabelText(/reason code/i), { target: { value: 'SCOPE_EXPANSION' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(adminService.updateRolePermissions).toHaveBeenCalledWith(
        'station_officer',
        expect.arrayContaining(['view_live_feeds', 'search_vehicles', 'manage_cameras']),
        'SCOPE_EXPANSION',
      ),
    );
  });

  it('removes a permission directly from the expanded role chip', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /security configuration/i }));
    fireEvent.click(await screen.findByLabelText('Expand Station Officer'));

    fireEvent.click(await screen.findByLabelText('Remove View Live Feeds from Station Officer'));

    await waitFor(() =>
      expect(adminService.updateRolePermissions).toHaveBeenCalledWith('station_officer', ['search_vehicles']),
    );
  });

  it('lists the fixed permission catalog on the Permissions tab, with how many roles use each', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /security configuration/i }));
    await screen.findByText('Station Officer');

    fireEvent.click(screen.getByRole('button', { name: /^permissions/i }));
    expect(await screen.findByText('View Live Feeds')).toBeInTheDocument();
    expect(screen.getByText('Manage Roles')).toBeInTheDocument();
  });
});

describe('Security Configuration (district_command)', () => {
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
    expect(screen.queryByText('Security Configuration')).not.toBeInTheDocument();
  });
});
