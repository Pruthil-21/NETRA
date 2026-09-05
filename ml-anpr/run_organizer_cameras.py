"""CLI wrapper for running the scalable pipeline (anpr.pipeline.orchestrator)
against P3's Organizer HLS relay -- cam01 through cam30, one URL pattern:
`<base>/stream/direct-camNN/index.m3u8?cookieCheck=1`.

The relay's hostname is a temporary Cloudflare quick tunnel (changes if
P3's container restarts), so it's never hardcoded here -- pass
--hls-base-url or set the HLS_BASE_URL env var each time.

num_workers defaults to 1, not len(cameras): real-tested on this Mac
(ALPR_IMPROVEMENT_LOG.md, the reconfirm-cooldown session) -- running 2
cameras concurrently on single-GPU hardware didn't give 2x throughput, it
produced ZERO confirmed events in 90s from either camera (frame queue
saturated, ~2.5s/frame instead of the usual few hundred ms). Only raise
--num-workers on real multi-GPU/multi-core hardware, and re-verify it
actually helps there rather than assuming it will.

Usage:
    python run_organizer_cameras.py --hls-base-url https://<tunnel>.trycloudflare.com
    python run_organizer_cameras.py --hls-base-url https://<tunnel>.trycloudflare.com --cameras 1-5
"""
import argparse
import os
import sys

from anpr.config import CAMERA_ID_MAP
from anpr.pipeline.orchestrator import ScalablePipeline

# A day -- effectively "run until Ctrl+C" for a live camera feed, without
# needing a second unbounded-run code path alongside ScalablePipeline's
# existing run_for().
_INDEFINITE_DURATION_SEC = 24 * 60 * 60


def _parse_camera_range(spec):
    """"1-30" -> [1..30], "1,3,7" -> [1,3,7], "5" -> [5]."""
    if "-" in spec:
        start, end = spec.split("-", 1)
        return list(range(int(start), int(end) + 1))
    return [int(n) for n in spec.split(",")]


def build_cameras(base_url, cam_numbers):
    return [
        (f"direct-cam{n:02d}", f"{base_url}/stream/direct-cam{n:02d}/index.m3u8?cookieCheck=1")
        for n in cam_numbers
    ]


def main():
    parser = argparse.ArgumentParser(description="Run the ANPR pipeline against P3's Organizer HLS relay.")
    parser.add_argument("--hls-base-url", default=os.environ.get("HLS_BASE_URL", ""),
                         help="Relay base URL, e.g. https://<tunnel>.trycloudflare.com (or set HLS_BASE_URL)")
    parser.add_argument("--cameras", default="1-30", help="Camera numbers, e.g. '1-30' or '1,3,7' (default: 1-30)")
    parser.add_argument("--num-workers", type=int, default=1,
                         help="Concurrent inference workers -- see module docstring before raising this")
    parser.add_argument("--sample-rate", type=int, default=15)
    args = parser.parse_args()

    if not args.hls_base_url:
        print("ERROR: --hls-base-url or HLS_BASE_URL env var is required (temporary tunnel, never hardcoded)",
              file=sys.stderr)
        sys.exit(1)

    cameras = build_cameras(args.hls_base_url, _parse_camera_range(args.cameras))

    unmapped = [cid for cid, _ in cameras if cid not in CAMERA_ID_MAP]
    if unmapped:
        print(f"[WARN] No numeric camera_id for: {', '.join(unmapped)} -- these will run real "
              f"detection locally but events won't reach the backend until CAMERA_ID_MAP covers them.",
              file=sys.stderr)

    pipeline = ScalablePipeline(cameras, num_workers=args.num_workers, sample_every_n=args.sample_rate)
    try:
        # run_for()'s own finally already calls pipeline.stop() before this
        # propagates -- nothing left to clean up here, just stop the traceback.
        pipeline.run_for(duration_sec=_INDEFINITE_DURATION_SEC, report_interval_sec=15)
    except KeyboardInterrupt:
        print("\nStopped by user.")


if __name__ == "__main__":
    main()
