"""Re-run the first-10-real-minutes Townhall accuracy test, this time
where the VLM fallback (gemma3:4b via Ollama) can actually fire --
Ollama wasn't reachable on this server until this same session's fix,
so every earlier accuracy number (including the 46.4% recall measured
against a real manual ground-truth count) was produced with the VLM
fallback silently unable to rescue anything.

Real bug found and fixed while building this: the original local-Mac
version of this test never called tracker.pop_ready_vlm_confirmations()
at all, so even a completed VLM rescue would never have been collected
into confirmed_plates/confirmed_by_tier. That call is required every
iteration (see VehicleTracker.update()'s own docstring) -- this version
does it correctly, matching the real pipeline's inference_worker.py.

Sequential cv2.read() only, no cap.set() seeking -- seeking was found
this session to corrupt HEVC frames right after a jump (missing
reference frames), which produced a false high failure rate in an
earlier diagnostic. Matches how the real FrameReader reads too.

Run from the repo root: `python benchmarks/townhall_10min_accuracy.py`.
"""
import glob
import json
import os
import sys
import time

import cv2

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REPO_ROOT)

VIDEO_NAME_HINT = "TOWNHALL"
WINDOW_MINUTES = 10
SAMPLE_EVERY_N = 10
VLM_DRAIN_TIMEOUT_SEC = 30

RESULTS_PATH = os.path.join(REPO_ROOT, "townhall_10min_accuracy_results.json")


def find_video():
    search_dirs = [
        os.path.expanduser("~/eval_videos"),
        os.path.expanduser("~"),
        REPO_ROOT,
        "/tmp",
        "/bkp/NETRA/data/eval_videos",
        "/bkp/NETRA/data/test-videos",
    ]
    patterns = ["*.mp4", "*.MP4", "*.avi", "*.AVI"]
    for d in search_dirs:
        if not os.path.isdir(d):
            continue
        for pat in patterns:
            for f in glob.glob(os.path.join(d, pat)):
                if VIDEO_NAME_HINT.lower() in os.path.basename(f).lower():
                    return f
    return None


def main():
    from anpr.detection import detect_plate_from_frame
    from anpr.tracking import VehicleTracker

    video_path = find_video()
    if video_path is None:
        print(f"ERROR: could not find a video with '{VIDEO_NAME_HINT}' in its name.")
        sys.exit(1)
    print(f"Using video: {video_path}")

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    end_frame = int(fps * 60 * WINDOW_MINUTES)
    print(f"fps={fps}, processing up to frame {end_frame} ({WINDOW_MINUTES} min), "
          f"sample_every_n={SAMPLE_EVERY_N}")

    tracker = VehicleTracker()
    confirmed_events = []
    idx, processed = 0, 0
    t0 = time.perf_counter()

    while idx < end_frame:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % SAMPLE_EVERY_N == 0:
            results = detect_plate_from_frame(frame, frame, tracker=tracker)
            # Both halves matter: update() returns normal-OCR confirmations
            # this frame, pop_ready_vlm_confirmations() collects any VLM
            # rescue that finished asynchronously since the last call --
            # exactly how inference_worker.py's real _worker_loop does it.
            confirmed = tracker.update(results, raw_frame=frame) + tracker.pop_ready_vlm_confirmations()
            confirmed_events.extend(confirmed)
            processed += 1
            if processed % 50 == 0:
                print(f"processed={processed} idx={idx}/{end_frame} "
                      f"elapsed={time.perf_counter()-t0:.0f}s "
                      f"vehicles={tracker.total_vehicles_tracked} "
                      f"confirmed={len(tracker.confirmed_plates)}", flush=True)
        idx += 1

    cap.release()

    # Tracks near the end of the window may have just dispatched a VLM
    # call (0.5-7s real latency) that hasn't completed yet -- give it
    # real wall-clock time rather than dropping a rescue that was almost
    # there.
    pending = tracker.pending_vlm_futures()
    if pending:
        print(f"draining {len(pending)} pending VLM future(s), up to {VLM_DRAIN_TIMEOUT_SEC}s...")
        deadline = time.time() + VLM_DRAIN_TIMEOUT_SEC
        while time.time() < deadline and any(not f.done() for f in pending):
            time.sleep(1)
        confirmed_events.extend(tracker.pop_ready_vlm_confirmations())

    elapsed = time.perf_counter() - t0
    vlm_confirmed = [e for e in confirmed_events if e["note"] == "ok - vlm fallback"]

    result = {
        "video": video_path,
        "window_minutes": WINDOW_MINUTES,
        "sample_every_n": SAMPLE_EVERY_N,
        "elapsed_sec": round(elapsed, 1),
        "frames_processed": processed,
        "vehicles_tracked": tracker.total_vehicles_tracked,
        "plate_candidates": tracker.total_plate_candidates,
        "confirmed_by_tier": tracker.confirmed_by_tier,
        "confirmed_plates": sorted(tracker.confirmed_plates),
        "vlm_fallback_confirmations": vlm_confirmed,
    }
    with open(RESULTS_PATH, "w") as f:
        json.dump(result, f, indent=2)

    print(f"\nDONE in {elapsed/60:.1f} min")
    print(f"vehicles_tracked={tracker.total_vehicles_tracked}")
    print(f"plate_candidates={tracker.total_plate_candidates}")
    print(f"confirmed_by_tier={tracker.confirmed_by_tier}")
    print(f"unique confirmed plates: {len(tracker.confirmed_plates)}")
    print(f"VLM fallback rescues: {len(vlm_confirmed)}")
    for e in vlm_confirmed:
        print(f"  {e['plate_number']} (confidence={e['confidence']})")
    print(f"\nResults: {RESULTS_PATH}")


if __name__ == "__main__":
    main()
