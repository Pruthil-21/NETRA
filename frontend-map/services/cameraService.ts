import { Camera } from '@/types/camera';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export const cameraService = {
  async getAll(): Promise<Camera[]> {
    const response = await fetch(`${API_BASE_URL}/cameras`, {
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch cameras: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },

  async getById(id: string | number): Promise<Camera> {
    const response = await fetch(`${API_BASE_URL}/cameras/${id}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch camera details for ID: ${id}`);
    }
    return response.json();
  },
};