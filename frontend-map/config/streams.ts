// Service base URLs — see contract/API_CONTRACT.md and each service's own README.
export const REGISTRY_API_URL = process.env.NEXT_PUBLIC_REGISTRY_API_URL || "http://localhost:8000";
export const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || "http://localhost:8001";
export const MEDIAMTX_HLS_URL = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL || "http://localhost:8888";

// Used when a camera has no resolvable live path (e.g. local dev with no MediaMTX running).
export const FALLBACK_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

// The actual HLS URL builder lives in lib/stream.ts (getCameraStreamUrl) --
// one place every caller (dashboard tiles, hover preview, detail drawer)
// resolves a camera's stream from, so they can never disagree on whether one
// is configured or what its URL is. A second, drifted builder used to live
// here; see useCameraFeeds.ts for why that was a real bug, not just
// duplication.
