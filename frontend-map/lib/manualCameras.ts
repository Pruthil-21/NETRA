import { OrganizerCamera } from '@/types/organizerCamera';
import { Camera } from '@/types/camera';

/**
 * Cameras added by an officer through the UI (single-add or bulk import),
 * kept in the exact same raw shape the organizer API itself returns so they
 * flow through the one existing mapper (organizerCameraToCamera) and inherit
 * the same placeholder rules — no parallel/duplicate logic to keep in sync.
 *
 * There's no backend write endpoint for this yet, so this is a client-side
 * stand-in: persisted to localStorage so it survives a refresh, but it is
 * NOT shared across officers/devices. Swap this for a real POST to
 * backend-registry once one exists — the raw shape won't need to change.
 */
const STORAGE_KEY = 'netra_manual_cameras';

// Reserved so manually added ids can never collide with an organizer camera
// (currently 1-30).
const MANUAL_ID_RANGE_START = 8000;
const MANUAL_ID_RANGE_END = 8999;

export function loadManualCameras(): OrganizerCamera[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveManualCameras(cameras: OrganizerCamera[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cameras));
}

/** Next free id in the manual range, given every camera already in the registry. */
export function nextManualId(existing: Camera[]): number {
  const used = new Set(existing.map((c) => c.id));
  for (let id = MANUAL_ID_RANGE_START; id <= MANUAL_ID_RANGE_END; id++) {
    if (!used.has(id)) return id;
  }
  throw new Error('Manual camera id range (8000-8999) is exhausted.');
}

export interface ParseResult {
  rows: OrganizerCamera[];
  errors: string[];
}

function coerceRow(raw: Record<string, string>, rowLabel: string): { row?: OrganizerCamera; error?: string } {
  const id = raw.id?.trim();
  if (!id) return { error: `${rowLabel}: missing required "id"` };

  const width = raw.width?.trim() ? Number(raw.width) : undefined;
  const height = raw.height?.trim() ? Number(raw.height) : undefined;
  const lat = raw.lat?.trim() ? Number(raw.lat) : undefined;
  const long = raw.long?.trim() ? Number(raw.long) : undefined;

  if (raw.width?.trim() && Number.isNaN(width)) return { error: `${rowLabel}: "width" is not a number` };
  if (raw.height?.trim() && Number.isNaN(height)) return { error: `${rowLabel}: "height" is not a number` };
  if (raw.lat?.trim() && Number.isNaN(lat)) return { error: `${rowLabel}: "lat" is not a number` };
  if (raw.long?.trim() && Number.isNaN(long)) return { error: `${rowLabel}: "long" is not a number` };

  return {
    row: {
      id,
      name: raw.name?.trim() || undefined,
      location: raw.location?.trim() || undefined,
      status: raw.status?.trim() || undefined,
      width,
      height,
      rtsp_url: raw.rtsp_url?.trim() || undefined,
      lat,
      long,
      stream_path: raw.stream_path?.trim() || undefined,
      hls_url: raw.hls_url?.trim() || undefined,
    },
  };
}

/** Minimal CSV parser for the backend's exact column set — handles quoted
 * fields with embedded commas, nothing fancier. Header row is required. */
export function parseCameraCsv(text: string): ParseResult {
  const lines = text.split(/\r\n|\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { rows: [], errors: ['File is empty.'] };

  const splitLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
  };

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const rows: OrganizerCamera[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const raw: Record<string, string> = {};
    header.forEach((col, idx) => {
      raw[col] = cells[idx] ?? '';
    });
    const { row, error } = coerceRow(raw, `Row ${i + 1}`);
    if (error) errors.push(error);
    if (row) rows.push(row);
  }

  return { rows, errors };
}

// Column order here is deliberately "flow-wise" -- identity first (id/name/
// location, what an officer types without a second thought), then position
// (lat/long), then the streaming fields (stream_path/hls_url/rtsp_url,
// whatever a technician actually hands over), then the least-often-filled
// signal hints (width/height/status) last. Every column matches coerceRow
// above exactly -- this is the one place both the parser and the sample
// template must stay in sync, so add a column here whenever coerceRow gains
// one, not the other way around.
const SAMPLE_ROWS: Record<string, string>[] = [
  {
    id: '101', name: 'Airport Circle Cam', location: 'Airport Circle, Ahmedabad',
    lat: '23.0733', long: '72.6314', stream_path: '12', hls_url: '', rtsp_url: 'rtsp://192.168.1.50:554/stream1',
    width: '1920', height: '1080', status: '',
  },
  {
    // Shows the "add now, connect the video later" case -- every streaming
    // column left blank is valid, the camera is just registry-only until
    // one is filled in (see AddCameraModal's same option).
    id: '102', name: 'Temporary Cam (no feed yet)', location: 'Ring Road, Ahmedabad',
    lat: '23.03', long: '72.58', stream_path: '', hls_url: '', rtsp_url: '',
    width: '', height: '', status: '',
  },
];
const SAMPLE_COLUMNS = ['id', 'name', 'location', 'lat', 'long', 'stream_path', 'hls_url', 'rtsp_url', 'width', 'height', 'status'];

/** Downloadable template for Bulk Import, in both accepted formats -- shows
 * the exact column set coerceRow understands, one fully-populated example
 * row and one "no live feed yet" example row, so the blank/optional columns
 * are obvious rather than only documented in prose above the upload button. */
export function buildSampleCsv(): string {
  const escape = (value: string) => (value.includes(',') || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [SAMPLE_COLUMNS.join(',')];
  for (const row of SAMPLE_ROWS) lines.push(SAMPLE_COLUMNS.map((col) => escape(row[col] ?? '')).join(','));
  return lines.join('\r\n');
}

export function buildSampleJson(): string {
  return JSON.stringify(
    SAMPLE_ROWS.map((row) => Object.fromEntries(SAMPLE_COLUMNS.map((col) => [col, row[col]]).filter(([, v]) => v !== ''))),
    null,
    2
  );
}

/** Accepts a JSON array of objects using the same field names as the CSV/API shape. */
export function parseCameraJson(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rows: [], errors: ['File is not valid JSON.'] };
  }
  if (!Array.isArray(parsed)) return { rows: [], errors: ['JSON root must be an array of camera objects.'] };

  const rows: OrganizerCamera[] = [];
  const errors: string[] = [];
  parsed.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`Row ${i + 1}: not an object`);
      return;
    }
    const asStrings: Record<string, string> = {};
    Object.entries(entry as Record<string, unknown>).forEach(([key, value]) => {
      if (value !== undefined && value !== null) asStrings[key.toLowerCase()] = String(value);
    });
    const { row, error } = coerceRow(asStrings, `Row ${i + 1}`);
    if (error) errors.push(error);
    if (row) rows.push(row);
  });

  return { rows, errors };
}
