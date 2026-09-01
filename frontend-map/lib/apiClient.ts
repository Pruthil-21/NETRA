/**
 * Shared fetch helper for backend-registry and backend-watchlist.
 *
 * HACKATHON SHORTCUT: /cameras (any authenticated user) and /alerts (officer role)
 * both require a JWT, and neither service has a login endpoint yet — this reuses one
 * token minted out-of-band and dropped in via env rather than a real login flow.
 * Replace with a proper auth flow post-hackathon.
 *
 * Pulled out of useCameraFeeds/AlertBanner so the two don't each carry their own copy
 * of this header logic — they drifted out of sync once already (one was pointed at the
 * wrong service URL for a while).
 */
export function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.NEXT_PUBLIC_DEMO_OFFICER_JWT || "";
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * A bare `TypeError: Failed to fetch` from the browser is ambiguous — it means either
 * "couldn't reach the host at all" (tunnel down/DNS) or "the backend rejected the CORS
 * preflight" (missing Access-Control-Allow-* headers for a request carrying our custom
 * Authorization header). curl-based checks won't reveal the second case since curl never
 * performs a preflight — this was mistaken for a dead tunnel more than once before the
 * actual cause (missing CORS middleware on backend-registry/backend-watchlist) was found.
 * Surface both possibilities instead of the raw browser message.
 */
export function describeFetchError(err: unknown, fallback: string): string {
  if (err instanceof TypeError && err.message === "Failed to fetch") {
    return "Could not reach the API — the tunnel may be down, or the backend needs CORS enabled for this origin.";
  }
  return err instanceof Error ? err.message : fallback;
}
