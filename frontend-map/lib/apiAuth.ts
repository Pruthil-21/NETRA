// Shared by every backend-watchlist client (detections, watchlist, alerts) --
// all three are officer-role JWT-gated per contract/API_CONTRACT.md, and all
// three need the exact same demo-JWT stand-in until a real login flow exists.
const DEMO_OFFICER_JWT = process.env.NEXT_PUBLIC_DEMO_OFFICER_JWT;

export function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(DEMO_OFFICER_JWT ? { Authorization: `Bearer ${DEMO_OFFICER_JWT}` } : {}),
  };
}

export function unauthorizedError(label: string): Error {
  return new Error(
    `Failed to ${label}: 401 Unauthorized (no demo JWT configured — set NEXT_PUBLIC_DEMO_OFFICER_JWT)`
  );
}

export function isJwtConfigured(): boolean {
  return Boolean(DEMO_OFFICER_JWT);
}
