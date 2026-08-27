import { NextResponse } from 'next/server';

const ORGANIZER_CAMERAS_URL = 'https://live.corp8.cloud/api/cameras';

export async function GET() {
  try {
    const res = await fetch(ORGANIZER_CAMERAS_URL, { cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json({ error: 'Organizer camera API returned an error' }, { status: 502 });
    }
    const data = await res.json();
    const cameras = Array.isArray(data) ? data : (data.cameras ?? data.data ?? []);
    return NextResponse.json({ cameras });
  } catch {
    return NextResponse.json({ error: 'Failed to reach the organizer camera API' }, { status: 502 });
  }
}
