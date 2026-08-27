/**
 * Curated coordinates for the 30 organizer cameras, keyed by camera id.
 *
 * The organizer's live camera API (https://live.corp8.cloud/api/cameras) does
 * not include coordinates — only a free-text `location` label (e.g.
 * "06 Timbavadi gate-Junagadh"). These entries were built by geocoding those
 * labels against OpenStreetMap/Nominatim, one-time and offline (not at
 * runtime). Confidence varies per camera:
 *
 * - 'landmark': the label matched a specific, identifiable real place
 *   (a named gate, temple, school, bridge, locality).
 * - 'city': the label's district/city was clear but the exact spot wasn't
 *   geocodable, so this is that city/town's centroid.
 * - 'unknown': the label had no reliably identifiable real-world location;
 *   this falls back to Gujarat's overall centroid rather than guessing.
 *
 * Replace any of these once a real surveyed coordinate is available (e.g.
 * from the Model 1 GIS registry once it's populated for these cameras).
 */
export type LocationConfidence = 'landmark' | 'city' | 'unknown';

export interface CuratedCoord {
  lat: number;
  long: number;
  confidence: LocationConfidence;
}

const GUJARAT_CENTER: [number, number] = [22.2587, 71.1924];

export const ORGANIZER_CAMERA_COORDS: Record<number, CuratedCoord> = {
  1: { lat: 23.0225, long: 72.5714, confidence: 'city' }, // Chimanbhai Bridge — Ahmedabad
  2: { lat: 23.0225, long: 72.5714, confidence: 'city' }, // Janpath — Ahmedabad (exact spot not geocodable)
  3: { lat: 23.1012, long: 72.0529, confidence: 'landmark' }, // ONGC (Cairn ONGC), Viramgam, Ahmedabad dist.
  4: { lat: 23.0175, long: 72.5645, confidence: 'landmark' }, // Paldi, Ahmedabad
  5: { lat: 23.1155, long: 72.6132, confidence: 'landmark' }, // Visat Char Rasta, Ahmedabad
  6: { lat: 21.5033, long: 70.4335, confidence: 'landmark' }, // Timbavadi, Junagadh
  7: { lat: 20.9298, long: 70.7628, confidence: 'city' }, // Gir Somnath district
  8: { lat: 21.5222, long: 70.4579, confidence: 'city' }, // Majewadi Gate — Junagadh city
  9: { lat: 21.522, long: 70.4582, confidence: 'city' }, // Junagadh city (bypass)
  10: { lat: 21.5225, long: 70.4585, confidence: 'city' }, // Char Chowk — Junagadh city
  11: { lat: 21.5588, long: 70.4659, confidence: 'landmark' }, // Dolatpara, Junagadh
  12: { lat: 23.1785, long: 72.5721, confidence: 'landmark' }, // Trimandir, Adalaj
  13: { lat: 23.0184, long: 72.5512, confidence: 'landmark' }, // C.N. Vidyalaya, Ahmedabad
  14: { lat: 23.0225, long: 72.5714, confidence: 'unknown' }, // "Delight" — no reliable match, Ahmedabad cluster guess
  15: { lat: 23.0225, long: 72.5714, confidence: 'unknown' }, // "Suvidha park" — no reliable match, Ahmedabad cluster guess
  16: { lat: 23.1155, long: 72.6132, confidence: 'landmark' }, // Visat P2, Ahmedabad (same area as #5)
  17: { lat: 22.3039, long: 70.8022, confidence: 'city' }, // Rajkot Bus Port — Rajkot city
  18: { lat: 22.3053, long: 70.8028, confidence: 'city' }, // Rajkot CCTV — Rajkot city
  19: { lat: 20.8389, long: 73.024, confidence: 'landmark' }, // Khaparia, Gandevi, Navsari
  20: { lat: GUJARAT_CENTER[0], long: GUJARAT_CENTER[1], confidence: 'unknown' }, // "Mohanpura" — ambiguous, multiple villages share the name
  21: { lat: 23.7738, long: 71.6799, confidence: 'city' }, // Patan Dethali Char Rasta — Patan city
  22: { lat: GUJARAT_CENTER[0], long: GUJARAT_CENTER[1], confidence: 'unknown' }, // "BK Mervada" — not reliably identifiable
  23: { lat: GUJARAT_CENTER[0], long: GUJARAT_CENTER[1], confidence: 'unknown' }, // "kheram" — not reliably identifiable
  24: { lat: 23.164, long: 72.8818, confidence: 'city' }, // Dehgam, Gandhinagar district
  25: { lat: 20.8389, long: 73.024, confidence: 'landmark' }, // Dhanori, Gandevi, Navsari
  26: { lat: 20.8606, long: 73.1306, confidence: 'landmark' }, // Tankal, Chikhli, Navsari
  27: { lat: 20.7672, long: 72.9693, confidence: 'city' }, // Bilimora, Navsari
  28: { lat: 20.7692, long: 72.9713, confidence: 'city' }, // Bilimora, Navsari (jittered from #27 to avoid an exact overlap)
  29: { lat: 20.7652, long: 72.9673, confidence: 'city' }, // Bilimora, Navsari (jittered from #27 to avoid an exact overlap)
  30: { lat: 23.0719, long: 70.1317, confidence: 'city' }, // Gandhidham, Kutch
};
