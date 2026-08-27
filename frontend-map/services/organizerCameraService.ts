import { Camera } from '@/types/camera';
import { OrganizerCamera } from '@/types/organizerCamera';
import { organizerCameraToCamera } from '@/lib/organizerCameras';

export const organizerCameraService = {
  async getAll(): Promise<Camera[]> {
    const res = await fetch('/api/organizer-cameras', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch organizer cameras');
    const { cameras }: { cameras: OrganizerCamera[] } = await res.json();
    return cameras.map(organizerCameraToCamera);
  },
};
