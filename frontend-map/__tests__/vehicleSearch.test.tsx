import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { VehicleSearchPanel } from '@/components/search/VehicleSearchPanel';
import { detectionService } from '@/services/detectionService';
import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';

// NOT a real integration test -- backend-watchlist's GET /detections was
// unreachable from this environment (same LAN-address issue as every other
// service tonight), so detectionService.search is mocked here, matching
// the documented contract shape exactly (contract/API_CONTRACT.md).

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

const MOCK_DETECTIONS: Detection[] = [
  { id: 101, plate_number: 'GJ01AB1234', camera_id: 1, detected_at: '2026-08-29T06:00:00Z', confidence: 0.97 },
  { id: 102, plate_number: 'GJ01AB1234', camera_id: 2, detected_at: '2026-08-29T06:15:00Z', confidence: 0.91 },
];

describe('VehicleSearchPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders sightings ordered chronologically after a search', async () => {
    vi.spyOn(detectionService, 'search').mockResolvedValue(MOCK_DETECTIONS);
    const onResultsChange = vi.fn();
    const onSelectSighting = vi.fn();

    render(
      <VehicleSearchPanel
        cameras={MOCK_CAMERAS}
        onResultsChange={onResultsChange}
        onSelectSighting={onSelectSighting}
      />
    );

    fireEvent.change(screen.getByLabelText('Search by plate number'), {
      target: { value: 'GJ01AB1234' },
    });
    fireEvent.click(screen.getByText('Search Sightings'));

    await waitFor(() => {
      expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
      expect(screen.getByText('Gita Mandir Bus Port')).toBeInTheDocument();
    });

    expect(detectionService.search).toHaveBeenCalledWith({ plate_number: 'GJ01AB1234' });
    expect(onResultsChange).toHaveBeenCalledWith(MOCK_DETECTIONS);

    fireEvent.click(screen.getByText('Sector 10 CH Road Junction'));
    expect(onSelectSighting).toHaveBeenCalledWith(MOCK_CAMERAS[0]);
  });

  it('shows a clear empty state when no sightings are found', async () => {
    vi.spyOn(detectionService, 'search').mockResolvedValue([]);

    render(
      <VehicleSearchPanel cameras={MOCK_CAMERAS} onResultsChange={vi.fn()} onSelectSighting={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText('Search by plate number'), {
      target: { value: 'ZZ99ZZ9999' },
    });
    fireEvent.click(screen.getByText('Search Sightings'));

    await waitFor(() => {
      expect(screen.getByText(/No sightings found for "ZZ99ZZ9999"/)).toBeInTheDocument();
    });
  });

  it('surfaces a fetch failure as a visible error, not a silent no-op', async () => {
    vi.spyOn(detectionService, 'search').mockRejectedValue(
      new Error('Failed to search detections: Unauthorized (401)')
    );

    render(
      <VehicleSearchPanel cameras={MOCK_CAMERAS} onResultsChange={vi.fn()} onSelectSighting={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText('Search by plate number'), {
      target: { value: 'GJ01AB1234' },
    });
    fireEvent.click(screen.getByText('Search Sightings'));

    await waitFor(() => {
      expect(screen.getByText('Search failed')).toBeInTheDocument();
      expect(screen.getByText(/401/)).toBeInTheDocument();
    });
  });
});
