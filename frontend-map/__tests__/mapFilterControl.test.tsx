import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CameraRegistryProvider, useCameraRegistry } from '@/context/CameraRegistryContext';
import { MapFilterControl } from '@/components/map/MapFilterControl';
import { Camera } from '@/types/camera';
import { Circle } from '@/services/circlesService';

const MOCK_CAMERAS: Camera[] = [
  {
    id: 1,
    name: 'Sector 10 CH Road Junction',
    dept: 'Ahmedabad',
    circle_id: null,
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
    name: 'Anand Bus Stand',
    dept: 'Anand',
    circle_id: 1,
    lat: 22.5645,
    long: 72.9289,
    camera_type: 'PTZ',
    ownership: 'Anand Police',
    connectivity_status: 'offline',
    storage_type: 'Local',
    retention_days: 15,
    health_status: 'fault',
    rtsp_url: 'rtsp://localhost:8554/cam2',
  },
  {
    id: 3,
    name: 'Anand Market Junction',
    dept: 'Anand',
    circle_id: 2,
    lat: 22.5605,
    long: 72.9315,
    camera_type: 'ANPR',
    ownership: 'Anand Police',
    connectivity_status: 'online',
    storage_type: 'Cloud',
    retention_days: 30,
    health_status: 'operational',
    rtsp_url: 'rtsp://localhost:8554/cam3',
  },
];

const MOCK_CIRCLES: Circle[] = [
  { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Petlad Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
];

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: () => Promise.resolve(MOCK_CIRCLES) },
}));

function TestConsumer() {
  const { filteredCameras } = useCameraRegistry();
  return (
    <ul>
      {filteredCameras.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  );
}

function renderControl() {
  return render(
    <CameraRegistryProvider>
      <MapFilterControl />
      <TestConsumer />
    </CameraRegistryProvider>
  );
}

async function openPanel() {
  renderControl();
  await waitFor(() => expect(screen.getByText('Anand Bus Stand')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('Camera filters'));
  await waitFor(() => expect(screen.getByLabelText('Search city or area')).toBeInTheDocument());
}

async function openLocationDropdown() {
  await openPanel();
  fireEvent.focus(screen.getByLabelText('Search city or area'));
  await waitFor(() => expect(screen.getByText('APC Circle')).toBeInTheDocument());
}

describe('MapFilterControl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => MOCK_CAMERAS }));
  });

  it('starts closed, showing only the Filters button', async () => {
    renderControl();
    await waitFor(() => expect(screen.getByText('Anand Bus Stand')).toBeInTheDocument());

    expect(screen.getByLabelText('Camera filters')).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by status')).not.toBeInTheDocument();
  });

  it('keeps the city/area list collapsed -- just the search box -- until it is focused', async () => {
    await openPanel();

    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
    expect(screen.queryByText('Ahmedabad')).not.toBeInTheDocument();

    fireEvent.focus(screen.getByLabelText('Search city or area'));
    expect(screen.getByText('APC Circle')).toBeInTheDocument();
    expect(screen.getByText('Ahmedabad')).toBeInTheDocument();
  });

  it('lists every city and every area, flat, once the search box is focused', async () => {
    await openLocationDropdown();

    expect(screen.getByText('Ahmedabad')).toBeInTheDocument();
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.getByText('APC Circle')).toBeInTheDocument();
    expect(screen.getByText('Petlad Circle')).toBeInTheDocument();
  });

  it('typing narrows the flat city+area list, Paytm-boarding-point style', async () => {
    await openLocationDropdown();

    fireEvent.change(screen.getByLabelText('Search city or area'), { target: { value: 'petlad' } });

    expect(screen.getByText('Petlad Circle')).toBeInTheDocument();
    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
    expect(screen.queryByText('Ahmedabad')).not.toBeInTheDocument();
  });

  it('selecting multiple cities keeps all of them, shown as removable chips', async () => {
    await openLocationDropdown();

    fireEvent.click(screen.getByText('Ahmedabad'));
    fireEvent.click(screen.getByText('Anand'));

    expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
    expect(screen.getByText('Anand Bus Stand')).toBeInTheDocument();
    expect(screen.getByText('Anand Market Junction')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove Ahmedabad filter'));
    expect(screen.queryByText('Sector 10 CH Road Junction')).not.toBeInTheDocument();
    expect(screen.getByText('Anand Bus Stand')).toBeInTheDocument();
  });

  it('combines status, a selected area, and a selected city with AND/OR as expected', async () => {
    await openLocationDropdown();

    // Offline AND (Ahmedabad city OR APC Circle area) -- Ahmedabad's camera
    // is online so it's excluded by status; APC Circle's camera is offline
    // so it survives; the other Anand camera (Petlad Circle) isn't in either
    // selected location and is excluded.
    fireEvent.click(screen.getByRole('button', { name: 'Offline' }));
    fireEvent.click(screen.getByText('Ahmedabad'));
    fireEvent.click(screen.getByText('APC Circle'));

    expect(screen.getByText('Anand Bus Stand')).toBeInTheDocument();
    expect(screen.queryByText('Anand Market Junction')).not.toBeInTheDocument();
    expect(screen.queryByText('Sector 10 CH Road Junction')).not.toBeInTheDocument();
  });

  it('shows an active-filter count badge and a working reset', async () => {
    await openLocationDropdown();

    fireEvent.click(screen.getByRole('button', { name: 'Offline' }));
    fireEvent.click(screen.getByText('Anand'));

    expect(screen.getByLabelText('Camera filters')).toHaveTextContent('2');

    fireEvent.click(screen.getByLabelText('Reset all active filters'));
    expect(screen.getByText('Sector 10 CH Road Junction')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reset all active filters')).not.toBeInTheDocument();
  });

  it('a click outside the dropdown but still inside the panel closes just the dropdown', async () => {
    await openLocationDropdown();

    // Status buttons live in the same panel, outside the location search's
    // own ref -- clicking one should dismiss the city/area list without
    // also closing the whole filters panel.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Offline' }));
    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
  });

  it('Escape closes the dropdown first, then the whole panel on a second press', async () => {
    await openLocationDropdown();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Filter by status')).not.toBeInTheDocument();
  });

  it('a click fully outside the panel closes everything, without discarding the selected filters', async () => {
    await openLocationDropdown();

    fireEvent.click(screen.getByText('Anand'));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByLabelText('Filter by status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Camera filters')).toHaveTextContent('1');
  });

  it('turning on the coverage map resets status to all and disables the Status buttons', async () => {
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Offline' }));
    expect(screen.getByRole('button', { name: 'Offline' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByLabelText('Show coverage map'));

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();
  });

  it('shows the red/green/amber legend once coverage is on', async () => {
    await openPanel();

    expect(screen.queryByText('Operational coverage')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show coverage map'));

    expect(screen.getByText('Operational coverage')).toBeInTheDocument();
    expect(screen.getByText('Registered, not operational')).toBeInTheDocument();
    expect(screen.getByText('No coverage')).toBeInTheDocument();
  });

  it('counts coverage as one active filter and reset turns it back off', async () => {
    await openPanel();

    fireEvent.click(screen.getByLabelText('Show coverage map'));
    expect(screen.getByLabelText('Camera filters')).toHaveTextContent('1');

    fireEvent.click(screen.getByLabelText('Reset all active filters'));
    expect(screen.queryByLabelText('Hide coverage map')).not.toBeInTheDocument();
    expect(screen.queryByText('Operational coverage')).not.toBeInTheDocument();
  });
});
