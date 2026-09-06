"""
Shared runtime config for the ANPR pipeline: repo-root path setup, device
selection, the loaded YOLO model, backend-watchlist endpoint/credentials,
and the OCR worker clients. Imported first by every other anpr.* module
(directly or transitively) since nearly everything downstream depends on
`device` or `yolo_model`.
"""
import os
import sys

import torch
from ultralytics import YOLO

# Allow importing streaming/rtsp_reader.py regardless of caller cwd --
# adds the repo root to the path so `streaming` is importable.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# Same reasoning, for the vendored nafnet/ package (Session 10) -- makes
# it importable regardless of caller cwd, not just when cwd happens to be
# ml-anpr/.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# ---------------------------------------------------------------------------
# Endpoint confirmed against contract/API_CONTRACT.md and backend-watchlist's
# actual routers/detections.py (origin/main @ cee989d): POST /alerts is
# retired, ml-anpr now calls POST /detections for every confirmed plate
# read (not just watchlist matches) -- see watchlist_client.py.
#
# Real X-Internal-Key and endpoint confirmed directly by P6 (backend side).
# NOTE: P6 gave this as http://localhost:8001/detections, i.e. assuming
# ml-anpr runs on the same machine/network as backend-watchlist. If ml-anpr
# ends up running elsewhere (as the old LAN IP here suggested it once did),
# this needs to go back to a reachable address, not localhost.
#
# Real camera_id mapping confirmed by P6 directly from GET /cameras
# (not guessed -- see ALPR_IMPROVEMENT_LOG.md).
#
# Physical camera identity behind each direct-camNN also now confirmed
# directly by Dhruv (streaming/relay side): the direct-camNN paths
# preserve the organizer portal's original camNN order (organizer camNN
# -> FFmpeg normalization -> MediaMTX /stream/direct-camNN), not
# arbitrary aliases, and that mapping is fixed even if a source
# disconnects or the tunnel URL changes. Full location list in
# ALPR_IMPROVEMENT_LOG.md.
#
# Worth a flag, not yet resolved: our own cam07.mp4 test footage's
# burned-in overlay reads "HERO SHOWROOM FIX-1", which matches
# direct-cam07's confirmed real location ("Hero Showroom, Gir Somnath")
# -- a real, independent signal that test footage is genuinely from this
# registered camera. But cam06.mp4's overlay reads "Madhuram Bypass Road
# Fix-2", which does NOT match direct-cam06's confirmed location
# ("Timbavadi Gate, Junagadh") -- don't assume cam06.mp4 corresponds to
# direct-cam06 without checking further.
#
# STILL OPEN: nothing in this codebase actually calls
# send_detection_to_watchlist with a "direct-camNN" camera_id string yet
# -- wiring an actual live/replay source to report as the correct
# direct-camNN is a separate task, not done here. This map is ready for
# that wiring, just not connected to anything live yet.
#
# The old "livecam"/"camera1"/"camera16" entries were removed, not kept
# as a fallback -- at the time, id 1 was a fictional demo camera with no
# real stream and id 16 didn't exist at all. That's now stale in a new
# way, not just historical: backend-registry has since renumbered the
# whole camera table (see backend-registry/scripts/backups/
# cleanup_and_renumber_cameras.sql on main, applied ~2026-09-03) down to
# a clean 30-camera set where id == the organizer's own camera number --
# id 1 is now direct-cam01's real id, not the old fictional one. Found
# by diffing this branch against main directly, not guessed: confirmed
# against backend-registry/scripts/backups/cameras_snapshot_2026-09-03.csv,
# which lists each camera's real stream_id (e.g. id 48 -> stream_id
# "direct-cam06") alongside its post-renumber id. Still true either way:
# watchlist_client.send_detection_to_watchlist no-ops with a clear [WARN]
# for any camera_id string not in this map, so an ever-stale-again
# mapping fails safe (silently skips sending) rather than misreporting
# to the wrong camera.
# ---------------------------------------------------------------------------
# P6's real backend-watchlist gateway, confirmed live and working: bare
# POST /detections (no prefix needed -- an earlier gateway config gap
# that made it look like /watchlist/detections was required has been
# fixed by P6), server-side event_id idempotency verified working,
# INTERNAL_KEY below verified correct against this same host. This is a
# Cloudflare quick tunnel, though -- it can change if P6's container
# restarts, same caveat as any other trycloudflare.com URL in this
# project; if calls start failing, ask P6 for a fresh URL before
# assuming anything else broke. STILL OPEN as of this same main-branch
# check: every real test this session got a real connection failure
# against this exact URL, and no newer URL exists anywhere in main's
# history either -- this needs a fresh URL from P6 directly, not
# something discoverable from the repo.
DETECTION_API_URL = "https://receiving-intl-mothers-santa.trycloudflare.com/detections"
INTERNAL_KEY = "3fdcd2e3b5fe0ecacd29d0b011c6cca74caddcbae5196a6b"
CAMERA_ID_MAP = {
    "direct-cam01": 1,
    "direct-cam02": 2,
    "direct-cam03": 3,
    "direct-cam04": 4,
    "direct-cam05": 5,
    "direct-cam06": 6,
    "direct-cam07": 7,
    "direct-cam08": 8,
    "direct-cam09": 9,
    "direct-cam10": 10,
    "direct-cam11": 11,
    "direct-cam12": 12,
    "direct-cam13": 13,
    "direct-cam14": 14,
    "direct-cam15": 15,
    "direct-cam16": 16,
    "direct-cam17": 17,
    "direct-cam18": 18,
    "direct-cam19": 19,
    "direct-cam20": 20,
    "direct-cam21": 21,
    "direct-cam22": 22,
    "direct-cam23": 23,
    "direct-cam24": 24,
    "direct-cam25": 25,
    "direct-cam26": 26,
    "direct-cam27": 27,
    "direct-cam28": 28,
    "direct-cam29": 29,
    "direct-cam30": 30,
}

if torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"
else:
    device = "cpu"

print(f"Using device: {device}")

yolo_model = YOLO("yolov8n.pt")
yolo_model.to(device)

# Swapped from EasyOCR after a head-to-head test on our own ground-truth
# images: PaddleOCR (PP-OCRv6) got 3/3 exact matches on raw output with
# zero custom correction logic, at 0.999-1.000 confidence, vs. EasyOCR's
# 0.45-0.93 (needing correction logic to reach the same 3/3). Full
# methodology and numbers in ALPR_IMPROVEMENT_LOG.md.
#
# GPU note: PaddleOCR's GPU build (paddlepaddle-gpu) cannot be imported in
# the same Windows process as torch -- both bundle same-named,
# differently-versioned CUDA DLLs (cudnn_cnn64_9.dll etc.), and whichever
# loads first "wins" that name process-wide, breaking the other
# framework's calls into it (verified directly, both import orders).
# Worse: once paddlepaddle-gpu is the installed package, importing
# `paddle` AT ALL -- even with device='cpu' -- unconditionally loads its
# bundled CUDA DLLs first (also verified directly), so there's no
# in-process CPU fallback available either. YOLO/NAFNet stay on torch in
# this process; all PaddleOCR inference (GPU primary, CPU fallback) runs
# in an isolated subprocess instead (ocr_gpu_worker.GpuOcrClient) -- a
# separate address space per client, so neither ever shares a process
# with torch. Same "always returns something usable" fallback philosophy
# as enhancement.enhance_motion_blur().
from ocr_gpu_worker import GpuOcrClient  # noqa: E402

_gpu_ocr_client = GpuOcrClient(device="gpu") if device == "cuda" else None
_cpu_ocr_client = GpuOcrClient(device="cpu")
