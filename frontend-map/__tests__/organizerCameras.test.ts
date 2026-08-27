import { describe, it, expect } from 'vitest';
import { organizerCameraToCamera } from '@/lib/organizerCameras';

describe('organizerCameraToCamera', () => {
  it('maps width > 0 to a preliminary online status', () => {
    const cam = organizerCameraToCamera({ id: '16', name: 'Camera 16', location: 'Visat P2', width: 1920, height: 1080 });
    expect(cam.connectivity_status).toBe('online');
    expect(cam.health_status).toBe('operational');
  });

  it('maps width 0 to a preliminary offline status without dropping the camera', () => {
    const cam = organizerCameraToCamera({ id: '1', name: 'Camera 1', location: '01 Chiman bhai Bridge', width: 0, height: 0 });
    expect(cam.connectivity_status).toBe('offline');
    expect(cam.health_status).toBe('degraded');
  });

  it('carries the organizer id through as both id and stream_id', () => {
    const cam = organizerCameraToCamera({ id: '23', name: 'Camera 23', width: 0, height: 0 });
    expect(cam.id).toBe(23);
    expect(cam.stream_id).toBe(23);
  });

  it('produces a stable position for the same id across calls', () => {
    const a = organizerCameraToCamera({ id: '7', width: 0, height: 0 });
    const b = organizerCameraToCamera({ id: '7', width: 0, height: 0 });
    expect(a.lat).toBe(b.lat);
    expect(a.long).toBe(b.long);
  });
});
