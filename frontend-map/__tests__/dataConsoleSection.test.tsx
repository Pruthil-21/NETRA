import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataConsoleSection } from '@/app/admin/DataConsoleSection';
import { dataConsoleService } from '@/services/dataConsoleService';
import { usePermissions } from '@/hooks/usePermissions';

vi.mock('@/services/dataConsoleService', () => ({
  dataConsoleService: {
    preview: vi.fn(),
    runExport: vi.fn(),
    runImport: vi.fn(),
    resubmitFailed: vi.fn(),
    listJobs: vi.fn(),
    download: vi.fn(),
  },
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

function mockPermissions(permissions: string[]) {
  (usePermissions as any).mockReturnValue({ permissions, loading: false });
}

// jsdom (this test environment) doesn't implement File.prototype.text() --
// every real browser this app actually runs in does, so this is a test-env
// gap to polyfill here, not something the component itself should work
// around.
if (!File.prototype.text) {
  File.prototype.text = function (this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

describe('DataConsoleSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (dataConsoleService.preview as any).mockResolvedValue(42);
    (dataConsoleService.runExport as any).mockResolvedValue({
      id: 1, entity_type: 'cameras', direction: 'export', format: 'csv',
      status: 'committed', total_rows: 42, success_rows: 42, failed_rows: 0,
      run_by: 'test', created_at: '2026-09-10T00:00:00Z',
    });
    (dataConsoleService.download as any).mockResolvedValue(undefined);
  });

  it('shows only entities the officer has permission for, grouped by domain', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);

    expect(await screen.findByRole('button', { name: 'Cameras' })).toBeInTheDocument();
    expect(screen.getByText('Camera Status History')).toBeInTheDocument();
    expect(screen.getByText('Coverage Targets')).toBeInTheDocument();
    // No manage_users_roles / view_audit_logs -- those entities' nav items
    // and their whole domain groups must not appear at all.
    expect(screen.queryByText('Officers')).not.toBeInTheDocument();
    expect(screen.queryByText('Audit Logs')).not.toBeInTheDocument();
    expect(screen.queryByText('Identity & Access')).not.toBeInTheDocument();
  });

  it('shows a message instead of a picker when the officer has no data-console permission at all', () => {
    mockPermissions([]);
    render(<DataConsoleSection />);
    expect(screen.getByText(/don't have permission to export or import/i)).toBeInTheDocument();
  });

  it('lands on the first visible entity and fetches a live preview count for it', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);

    await waitFor(() => expect(dataConsoleService.preview).toHaveBeenCalledWith('cameras', {}));
    expect(await screen.findByText('42')).toBeInTheDocument();
  });

  it('switching entities resets filters and re-previews against the new entity', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.click(screen.getByText('Coverage Targets'));
    await waitFor(() =>
      expect(dataConsoleService.preview).toHaveBeenCalledWith('coverage_targets', {})
    );
  });

  it('typing a district filter narrows the preview for the selected entity', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.change(screen.getByLabelText('District'), { target: { value: 'Anand' } });
    await waitFor(() =>
      expect(dataConsoleService.preview).toHaveBeenCalledWith('cameras', { district: 'Anand' }),
      { timeout: 1000 }
    );
  });

  it('running an export calls runExport with the current filters and format, downloads it, and shows it under Just Ran', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.click(screen.getByRole('button', { name: 'XLSX' }));
    fireEvent.click(screen.getByRole('button', { name: /run export/i }));

    await waitFor(() => expect(dataConsoleService.runExport).toHaveBeenCalledWith('cameras', 'xlsx', {}));
    await waitFor(() => expect(dataConsoleService.download).toHaveBeenCalledWith(1, 'cameras', 'xlsx'));
    expect(await screen.findByText(/Export #1/)).toBeInTheDocument();
  });

  it('switching entities clears the Just Ran list from the previous one', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.click(screen.getByRole('button', { name: /run export/i }));
    expect(await screen.findByText(/Export #1/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Coverage Targets'));
    await waitFor(() =>
      expect(screen.queryByText(/Export #1/)).not.toBeInTheDocument()
    );
  });

  it('importing a file with failed rows surfaces a resubmit action', async () => {
    mockPermissions(['manage_cameras']);
    (dataConsoleService.runImport as any).mockResolvedValue({
      id: 7, entity_type: 'cameras', direction: 'import', format: 'csv',
      status: 'committed', total_rows: 3, success_rows: 2, failed_rows: 1,
      run_by: 'test', created_at: '2026-09-10T00:00:00Z',
    });
    (dataConsoleService.resubmitFailed as any).mockResolvedValue({
      id: 8, entity_type: 'cameras', direction: 'import', format: 'csv',
      status: 'committed', total_rows: 1, success_rows: 0, failed_rows: 1,
      run_by: 'test', created_at: '2026-09-10T00:01:00Z',
    });

    const { container } = render(<DataConsoleSection />);
    await screen.findByText('42');

    const file = new File(['name,dept\nBad Cam,Anand'], 'cameras.csv', { type: 'text/csv' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(dataConsoleService.runImport).toHaveBeenCalledWith('cameras', 'csv', [
      { name: 'Bad Cam', dept: 'Anand' },
    ]));

    const resubmitButton = await screen.findByTitle('Resubmit failed rows');
    fireEvent.click(resubmitButton);
    await waitFor(() => expect(dataConsoleService.resubmitFailed).toHaveBeenCalledWith(7));
  });

  it('offers sample CSV/JSON downloads for an entity that supports import', async () => {
    mockPermissions(['manage_cameras']);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.click(screen.getByRole('button', { name: /download sample csv/i }));
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /download sample json/i }));
    expect(createUrlSpy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it('does not offer sample downloads for an entity with no import support', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');

    fireEvent.click(screen.getByText('Coverage Targets'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /download sample csv/i })).not.toBeInTheDocument()
    );
  });

  it('offers a link to the full history in Audit Log only when the officer can see it', async () => {
    mockPermissions(['manage_cameras', 'view_audit_logs']);
    const onViewAuditLog = vi.fn();
    render(<DataConsoleSection onViewAuditLog={onViewAuditLog} />);
    await screen.findByText('42');

    const link = screen.getByRole('button', { name: /full history in audit log/i });
    fireEvent.click(link);
    expect(onViewAuditLog).toHaveBeenCalled();
  });

  it('hides the Audit Log link when the officer lacks view_audit_logs', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection onViewAuditLog={vi.fn()} />);
    await screen.findByText('42');
    expect(screen.queryByRole('button', { name: /full history in audit log/i })).not.toBeInTheDocument();
  });

  it('shows the audit-log category chips only for the Audit Logs entity', async () => {
    mockPermissions(['view_audit_logs']);
    render(<DataConsoleSection />);
    await screen.findByText('42');
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('shows the Traffic Analytics entities only with view_analytics', async () => {
    mockPermissions(['manage_cameras']);
    render(<DataConsoleSection />);
    await screen.findByText('42');
    expect(screen.queryByText('Traffic Analytics')).not.toBeInTheDocument();
    expect(screen.queryByText('Plate Sightings')).not.toBeInTheDocument();
  });

  it('seeds a default live 30-minute window for Traffic Density and previews against it', async () => {
    mockPermissions(['view_analytics']);
    render(<DataConsoleSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Traffic Density' }));
    await waitFor(() =>
      expect(dataConsoleService.preview).toHaveBeenCalledWith('traffic_density', { window_minutes: 30 })
    );
  });

  it('switching Traffic Density to Hour of day mode replaces window_minutes with hour/date', async () => {
    mockPermissions(['view_analytics']);
    render(<DataConsoleSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Traffic Density' }));
    await waitFor(() =>
      expect(dataConsoleService.preview).toHaveBeenCalledWith('traffic_density', { window_minutes: 30 })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hour of day' }));
    await waitFor(() => {
      const lastCall = (dataConsoleService.preview as any).mock.calls.at(-1);
      expect(lastCall[0]).toBe('traffic_density');
      expect(lastCall[1]).toHaveProperty('hour');
      expect(lastCall[1]).toHaveProperty('date');
      expect(lastCall[1]).not.toHaveProperty('window_minutes');
    });
  });
});
