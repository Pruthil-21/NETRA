import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CameraRegistryProvider } from '@/context/CameraRegistryContext';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import { Camera } from '@/types/camera';

const CAMERA: Camera = {
  id: 1,
  name: 'Sector 10 CH Road Junction',
  dept: 'Home / Police',
  lat: 23.2156,
  long: 72.6369,
  camera_type: 'ANPR',
  ownership: 'Gandhinagar Police',
  connectivity_status: 'online',
  storage_type: 'Cloud',
  retention_days: 30,
  health_status: 'operational',
  rtsp_url: 'rtsp://localhost:8554/cam1',
};

const DEVICE = {
  id: 'cam01',
  name: 'cam01',
  status: 'online',
  reachable: true,
  snmp_mode: 'mock',
  snmp_state: 'simulated',
  metrics: { cpu_percent: 42, memory_percent: 55, network_mbps: 12.3, temperature_celsius: 48 },
  last_checked_at: '2026-09-05T00:00:00Z',
};

describe('CameraDetailDrawer Device Health panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the monitor\'s metrics for the selected camera', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/health')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => DEVICE });
        }
        if (String(url).includes('/uptime')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ camera_id: 1, current_status: 'online', windows: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      })
    );
    render(
      <CameraRegistryProvider>
        <CameraDetailDrawer camera={CAMERA} />
      </CameraRegistryProvider>
    );

    await waitFor(() => expect(screen.getByText('42%')).toBeInTheDocument());
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('12.3 Mbps')).toBeInTheDocument();
    expect(screen.getByText('48°C')).toBeInTheDocument();
  });

  it('shows "Not available" when the monitor has nothing for this camera', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/health')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        if (String(url).includes('/uptime')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ camera_id: 1, current_status: 'online', windows: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      })
    );
    render(
      <CameraRegistryProvider>
        <CameraDetailDrawer camera={CAMERA} />
      </CameraRegistryProvider>
    );

    await waitFor(() => expect(screen.getByText('Not available')).toBeInTheDocument());
  });
});
