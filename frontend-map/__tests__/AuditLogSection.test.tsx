import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AuditLogSection } from '@/app/admin/AuditLogSection';
import { CameraRegistryProvider } from '@/context/CameraRegistryContext';

const CAMERA_LOG = {
  id: 1, badge_number: 'GJ-SO-001', action: 'create', resource_type: 'camera', resource_id: 7,
  reason_code: null, timestamp: '2026-09-05T10:00:00Z', category: 'camera_registry',
  actor_name: 'Demo Station Officer', camera_name: 'Ring Road Cam', camera_district: 'Traffic Police', camera_area: 'Ring Road Circle',
};

const LOGIN_LOG = {
  id: 2, badge_number: 'GJ-SA-001', action: 'login', resource_type: 'officer', resource_id: null,
  reason_code: null, timestamp: '2026-09-05T09:00:00Z', category: 'authentication',
  actor_name: 'Demo Super Admin', camera_name: null, camera_district: null, camera_area: null,
};

function renderSection() {
  return render(
    <CameraRegistryProvider>
      <AuditLogSection />
    </CameraRegistryProvider>
  );
}

describe('AuditLogSection', () => {
  beforeEach(() => {
    sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
  });

  it('shows a human-readable description and resolved camera location instead of raw action/resource_type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/audit-logs/categories')) {
          return Promise.resolve({ ok: true, json: async () => ({ categories: ['authentication', 'camera_registry'] }) });
        }
        if (url.includes('/audit-logs')) {
          return Promise.resolve({ ok: true, json: async () => ({ logs: [CAMERA_LOG], next_cursor: null }) });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    renderSection();

    expect(await screen.findByText('Added a camera')).toBeInTheDocument();
    expect(screen.getByText('Ring Road Cam')).toBeInTheDocument();
    expect(screen.getByText('Ring Road Circle, Traffic Police')).toBeInTheDocument();
    expect(screen.getByText('Demo Station Officer')).toBeInTheDocument();
  });

  it('refetches scoped to that category when a category chip is clicked', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        if (url.includes('/audit-logs/categories')) {
          return Promise.resolve({ ok: true, json: async () => ({ categories: ['authentication', 'camera_registry'] }) });
        }
        if (url.includes('/audit-logs')) {
          return Promise.resolve({ ok: true, json: async () => ({ logs: [LOGIN_LOG], next_cursor: null }) });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    renderSection();
    expect(await screen.findByRole('button', { name: /^login$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^login$/i }));

    await waitFor(() =>
      expect(calls.some((u) => u.includes('/audit-logs?') && u.includes('category=authentication'))).toBe(true)
    );
  });

  it('sends the camera ID, district, and area filters when Apply is clicked', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        if (url.includes('/audit-logs/categories')) {
          return Promise.resolve({ ok: true, json: async () => ({ categories: [] }) });
        }
        if (url.includes('/audit-logs')) {
          return Promise.resolve({ ok: true, json: async () => ({ logs: [], next_cursor: null }) });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/camera id/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/camera id/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));

    await waitFor(() =>
      expect(calls.some((u) => u.includes('/audit-logs?') && u.includes('camera_id=7'))).toBe(true)
    );
  });
});
