import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CameraRegistryProvider, useCameraRegistry } from '../context/CameraRegistryContext';
import { organizerCameraService } from '@/services/organizerCameraService';
import CameraCard from '@/components/registry/CameraCard';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import Badge from '@/components/common/Badge';
import { Camera } from '@/types/camera';
import { CameraFilters } from '@/types/filters';

const MOCK_CAMERAS: Camera[] = [
  {
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
  },
  {
    id: 2,
    name: 'Gita Mandir Bus Port',
    dept: 'Transport / GSRTC',
    lat: 23.0131,
    long: 72.5873,
    camera_type: 'PTZ',
    ownership: 'GSRTC Hub',
    connectivity_status: 'offline',
    storage_type: 'Local',
    retention_days: 15,
    health_status: 'fault',
    rtsp_url: 'rtsp://localhost:8554/cam2',
  },
];

describe('P2 Frontend Map: Feature Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Feature 1: Badge component renders correct health/status variants', () => {
    const { rerender } = render(<Badge status="online" text="Online" />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Online').className).toContain('text-signal-green');

    rerender(<Badge status="offline" text="Offline" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Offline').className).toContain('text-signal-red');
  });

  it('Feature 2: CameraCard component displays metadata and selection state', () => {
    const handleSelect = vi.fn();
    const { rerender } = render(
      <CameraCard camera={MOCK_CAMERAS[0]} isSelected={false} onSelect={handleSelect} />
    );

    expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Sector 10 CH Road Junction'));
    expect(handleSelect).toHaveBeenCalledTimes(1);

    rerender(<CameraCard camera={MOCK_CAMERAS[0]} isSelected={true} onSelect={handleSelect} />);
    expect(screen.getByRole('button', { name: /Sector 10 CH Road Junction/ }).className).toContain(
      'border-l-command'
    );
  });

  it('Feature 3: CameraDetailDrawer displays complete PostGIS registry fields', () => {
    vi.spyOn(organizerCameraService, 'getAll').mockResolvedValue([]);
    render(
      <CameraRegistryProvider>
        <CameraDetailDrawer camera={MOCK_CAMERAS[0]} />
      </CameraRegistryProvider>
    );

    expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Gandhinagar Police')).toBeInTheDocument();
    expect(screen.getByText('Cloud Architecture')).toBeInTheDocument();
    expect(screen.getByText('30 Days Archival Policy')).toBeInTheDocument();
    expect(screen.getByText('rtsp://localhost:8554/cam1')).toBeInTheDocument();
  });

  it('Feature 4: CameraRegistryContext filters data accurately by Department', async () => {
    vi.spyOn(organizerCameraService, 'getAll').mockResolvedValue(MOCK_CAMERAS);

    function TestConsumer() {
      const { filteredCameras, setFilters } = useCameraRegistry();
      return (
        <div>
          <button
            onClick={() =>
              setFilters((prev: CameraFilters) => ({ ...prev, department: 'Transport / GSRTC' }))
            }
          >
            Filter Transport
          </button>
          <ul>
            {filteredCameras.map((c: Camera) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        </div>
      );
    }

    render(
      <CameraRegistryProvider>
        <TestConsumer />
      </CameraRegistryProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
      expect(screen.getByText('Gita Mandir Bus Port')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Filter Transport'));

    await waitFor(() => {
      expect(screen.queryByText('Sector 10 CH Road Junction')).not.toBeInTheDocument();
      expect(screen.getByText('Gita Mandir Bus Port')).toBeInTheDocument();
    });
  });
});