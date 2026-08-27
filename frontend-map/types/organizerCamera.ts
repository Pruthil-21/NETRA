/**
 * Raw camera shape returned by the organizer's live CCTV metadata API
 * (https://live.corp8.cloud/api/cameras, proxied via /api/organizer-cameras).
 * Only the fields this app actually uses are declared.
 */
export interface OrganizerCamera {
  id: string;
  name?: string;
  location?: string;
  status?: string;
  width?: number;
  height?: number;
  rtsp_url?: string;
}
