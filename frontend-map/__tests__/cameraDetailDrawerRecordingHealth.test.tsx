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

function stubFetchWithRecordingHealthEvents(events: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (String(url).includes('/recordings/health-events')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => events });
      }
      if (String(url).includes('/uptime')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ camera_id: 1, current_status: 'online', windows: [] }) });
      }
      if (String(url).includes('/health')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    })
  );
}

describe('CameraDetailDrawer Recording Health panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows recent recording-health events for the selected camera', async () => {
    stubFetchWithRecordingHealthEvents([
      {
        event_id: 'evt-1', stream_id: '7', status: 'recording', message: 'segment uploaded',
        occurred_at: '2026-09-08T10:00:00Z', received_at: '2026-09-08T10:00:01Z',
      },
    ]);

    render(
      <CameraRegistryProvider>
        <CameraDetailDrawer camera={CAMERA} />
      </CameraRegistryProvider>
    );

    await waitFor(() => expect(screen.getByText('recording')).toBeInTheDocument());
    expect(screen.getByText('segment uploaded')).toBeInTheDocument();
  });

  it('shows a quiet empty state when nothing has been reported yet', async () => {
    stubFetchWithRecordingHealthEvents([]);

    render(
      <CameraRegistryProvider>
        <CameraDetailDrawer camera={CAMERA} />
      </CameraRegistryProvider>
    );

    await waitFor(() => expect(screen.getByText('No recording status reported yet.')).toBeInTheDocument());
  });
});
