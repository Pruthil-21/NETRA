"""Smoke test for the process-based ScalablePipeline (see
ALPR_IMPROVEMENT_LOG.md: InferenceWorkers moved from threads to separate
OS processes after real GPU-server testing showed thread-based workers
caused catastrophic slowdown, not just no speedup). Loads real models in
a real child process, not mocked -- meant to be run directly
(`python tests/test_pipeline_mp_smoke.py`) after any change to
anpr/pipeline/, not on every commit, matching this project's existing
tests/test_pipeline_smoke.py convention.

Verifies the things unique to the process rewrite that a thread-based
test wouldn't catch: the child process actually produces confirmed
events, and its VehicleTracker state (only reachable via the stats-queue
bridge on stop(), never as a live shared-memory attribute) makes it back
to the main process's ScalablePipeline.tracker_summary().
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from anpr.pipeline.orchestrator import ScalablePipeline  # noqa: E402

VIDEO_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dashcam_trimmed.mp4"))

if __name__ == "__main__":
    cameras = [("direct-cam06", VIDEO_PATH)]
    pipeline = ScalablePipeline(cameras, num_workers=1, sample_every_n=15)
    snapshot = pipeline.run_for(duration_sec=40, report_interval_sec=10)
    summary = pipeline.tracker_summary()

    assert snapshot["frames_processed"] > 0, "no frames processed -- worker process likely never started"
    assert "direct-cam06" in summary, "tracker_summary missing the camera -- stats bridge from child process broken"
    assert summary["direct-cam06"]["vehicles_tracked"] > 0, "no vehicles tracked in the child process"
    assert summary["direct-cam06"]["confirmed_plates"], "no plates confirmed -- expected real hits on this clip"

    print(f"OK: process-based pipeline produced real detections and reported them back: {summary}")
