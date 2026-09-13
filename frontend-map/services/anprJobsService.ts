import { WATCHLIST_API_URL } from '@/config/streams';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';
import { getToken } from '@/lib/session';

export type AnprInputType = 'upload_video' | 'upload_image' | 'archive_clip';
export type AnprJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AnprJobResult {
  id: number;
  detection_id: number | null;
  plate_number: string;
  confidence: number | null;
  /** The real in-footage moment for a video/clip job; null for a photo,
   * which has no timeline to place it on. */
  detected_at: string | null;
  /** Normalized 0-1 fraction of frame area -- the ordering signal for a
   * photo's nearest-to-farthest sort; null when ml-anpr didn't report one. */
  box_area: number | null;
}

export interface AnprJob {
  id: number;
  input_type: AnprInputType;
  status: AnprJobStatus;
  submitted_by: string;
  district: string;
  original_filename: string | null;
  file_size_bytes: number | null;
  file_sha256: string | null;
  source_camera_id: number | null;
  clip_start: string | null;
  clip_end: string | null;
  /** upload_video only, officer-supplied at upload time. */
  recorded_at: string | null;
  detection_id: number | null;
  plate_number: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  /** Every plate found, already ordered by the backend: nearest-to-farthest
   * for a photo, chronological for a video/clip. Empty on a job that's
   * still pending/processing, or one that completed with nothing found. */
  results: AnprJobResult[];
}

async function handle<T>(response: Response, label: string): Promise<T> {
  if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError(label);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail || `Failed to ${label}: HTTP ${response.status}`);
  }
  return response.json();
}

export const anprJobsService = {
  async list(): Promise<AnprJob[]> {
    const response = await fetch(`${WATCHLIST_API_URL}/anpr-jobs`, { headers: authHeaders(), cache: 'no-store' });
    return handle(response, 'list plate lookup jobs');
  },

  async get(id: number): Promise<AnprJob> {
    const response = await fetch(`${WATCHLIST_API_URL}/anpr-jobs/${id}`, { headers: authHeaders(), cache: 'no-store' });
    return handle(response, 'fetch plate lookup job');
  },

  async submitArchiveClip(input: {
    sourceCameraId: number;
    clipStart: string;
    clipEnd: string;
  }): Promise<AnprJob> {
    const response = await fetch(`${WATCHLIST_API_URL}/anpr-jobs/archive-clip`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        source_camera_id: input.sourceCameraId,
        clip_start: input.clipStart,
        clip_end: input.clipEnd,
      }),
    });
    return handle(response, 'submit archive clip for plate lookup');
  },

  /** Uses XMLHttpRequest (not fetch) specifically for its upload.onprogress
   * event -- fetch has no equivalent for outbound upload progress. Must NOT
   * set Content-Type manually (unlike authHeaders(), which does, for JSON
   * bodies) -- the browser sets it itself with the multipart boundary. */
  submitUpload(
    input: {
      inputType: 'upload_video' | 'upload_image';
      district: string;
      file: File;
      /** upload_video only -- "approximately when was this recorded?" ISO
       * string. Optional: an arbitrary uploaded file otherwise has no
       * real-world time anchor, so plates found in it can't be timestamped
       * (same as a photo) unless the officer supplies one. */
      recordedAt?: string;
    },
    onProgress?: (fraction: number) => void
  ): Promise<AnprJob> {
    return new Promise((resolve, reject) => {
      const token = getToken();
      if (!token && isJwtConfigured() === false) {
        reject(unauthorizedError('submit plate lookup upload'));
        return;
      }

      const formData = new FormData();
      formData.append('input_type', input.inputType);
      formData.append('district', input.district);
      formData.append('file', input.file);
      if (input.recordedAt) formData.append('recorded_at', input.recordedAt);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${WATCHLIST_API_URL}/anpr-jobs/upload`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // non-JSON error body, handled by the status check below
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as AnprJob);
        } else {
          const detail = (body as { detail?: string } | null)?.detail;
          reject(new Error(detail || `Failed to submit plate lookup upload: HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('Failed to submit plate lookup upload: network error'));
      xhr.send(formData);
    });
  },
};
