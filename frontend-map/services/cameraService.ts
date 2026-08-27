import { Camera } from '@/types/camera';

const BASE_URL = process.env.NEXT_PUBLIC_REGISTRY_API_URL || 'http://localhost:5001';

export const cameraService = {
  async getAll(): Promise<Camera[]> {
    const res = await fetch(`${BASE_URL}/cameras`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch cameras');
    return await res.json();
  },
};