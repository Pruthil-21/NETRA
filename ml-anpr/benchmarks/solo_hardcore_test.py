"""Solo, single-camera hardcore/stress test -- isolates the pipeline's true
per-frame GPU/CPU behavior from the contention a multi-camera run
introduces (see ALPR_IMPROVEMENT_LOG.md for the 6-camera stress test this
follows up on). Launches its own GPU (nvidia-smi) and CPU/memory (/proc)
monitors as background threads/subprocesses, so nothing has to be
remembered or started separately. Writes everything to disk continuously
-- safe to leave unattended (nohup).

Run from the repo root: `python benchmarks/solo_hardcore_test.py`.
Set VIDEO_NAME_HINT / DURATION_SEC / SAMPLE_EVERY_N below for a different
video or duration -- no CLI args, kept a one-off diagnostic script like
the rest of this directory.
"""
import glob
import json
import os
import subprocess
import sys
import threading
import time

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REPO_ROOT)

DURATION_SEC = 25 * 60
REPORT_INTERVAL_SEC = 60
SAMPLE_EVERY_N = 10
SYS_LOG_INTERVAL_SEC = 15
VIDEO_NAME_HINT = "TOWNHALL"

GPU_LOG_PATH = os.path.join(REPO_ROOT, "solo_test_gpu_log.csv")
SYS_LOG_PATH = os.path.join(REPO_ROOT, "solo_test_sys_log.csv")
RESULTS_PATH = os.path.join(REPO_ROOT, "solo_test_results.json")


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


def start_gpu_logger():
    """nvidia-smi as its own subprocess, writing CSV directly -- robust
    even if this Python process later hangs; killed explicitly at the end
    so it doesn't outlive the test."""
    try:
        proc = subprocess.Popen(
            ["nvidia-smi",
             "--query-gpu=timestamp,memory.used,memory.total,utilization.gpu,"
             "utilization.memory,temperature.gpu,power.draw",
             "--format=csv", "-l", str(SYS_LOG_INTERVAL_SEC)],
            stdout=open(GPU_LOG_PATH, "w"), stderr=subprocess.STDOUT,
        )
        return proc
    except FileNotFoundError:
        print("[WARN] nvidia-smi not found -- no GPU log will be produced")
        return None


def _read_proc_stat():
    with open("/proc/stat") as f:
        parts = f.readline().split()
    vals = list(map(int, parts[1:]))
    idle = vals[3] + vals[4]  # idle + iowait
    total = sum(vals)
    return idle, total


def _read_mem():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            info[k.strip()] = int(v.strip().split()[0])  # kB
    return info


def sys_monitor_loop(stop_event):
    """CPU% (from /proc/stat deltas, no extra dependency) + memory/swap
    (from /proc/meminfo) + load average, every SYS_LOG_INTERVAL_SEC.
    Pure stdlib -- works even if psutil was never installed here."""
    with open(SYS_LOG_PATH, "w") as f:
        f.write("timestamp,cpu_pct,load1,load5,load15,mem_available_gb,mem_total_gb,swap_used_gb\n")
        prev_idle, prev_total = _read_proc_stat()
        while not stop_event.wait(SYS_LOG_INTERVAL_SEC):
            idle, total = _read_proc_stat()
            d_idle, d_total = idle - prev_idle, total - prev_total
            cpu_pct = 100.0 * (1 - d_idle / d_total) if d_total > 0 else float("nan")
            prev_idle, prev_total = idle, total

            load1, load5, load15 = os.getloadavg()
            mem = _read_mem()
            mem_avail_gb = mem.get("MemAvailable", 0) / 1e6
            mem_total_gb = mem.get("MemTotal", 0) / 1e6
            swap_used_gb = (mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)) / 1e6

            f.write(f"{time.time():.0f},{cpu_pct:.1f},{load1:.2f},{load5:.2f},{load15:.2f},"
                    f"{mem_avail_gb:.2f},{mem_total_gb:.2f},{swap_used_gb:.2f}\n")
            f.flush()


def main():
    from anpr.pipeline.orchestrator import ScalablePipeline

    video_path = find_video()
    if video_path is None:
        print(f"ERROR: could not find a video with '{VIDEO_NAME_HINT}' in its name.")
        print("Copy the video to ~/eval_videos/ on this server first, then re-run.")
        sys.exit(1)
    print(f"Using video: {video_path}")

    gpu_proc = start_gpu_logger()
    stop_sys_monitor = threading.Event()
    sys_thread = threading.Thread(target=sys_monitor_loop, args=(stop_sys_monitor,), daemon=True)
    sys_thread.start()
    print(f"GPU log -> {GPU_LOG_PATH}\nCPU/mem log -> {SYS_LOG_PATH}")

    # Deliberately NOT a "direct-camNN" id -- see hardcore_test.py's same
    # comment; unmapped ids run real inference but never reach the real
    # backend (EventSender no-ops with a [WARN], counted as a failed
    # send, not silently dropped -- expected, not a bug).
    cameras = [("solotest-townhall", video_path)]

    print(f"num_workers=1  sample_every_n={SAMPLE_EVERY_N}  duration={DURATION_SEC}s")
    pipeline = ScalablePipeline(cameras, num_workers=1, sample_every_n=SAMPLE_EVERY_N)
    t0 = time.time()
    final_report = pipeline.run_for(duration_sec=DURATION_SEC, report_interval_sec=REPORT_INTERVAL_SEC)
    elapsed = time.time() - t0

    stop_sys_monitor.set()
    sys_thread.join(timeout=5)
    if gpu_proc is not None:
        gpu_proc.terminate()

    summary = pipeline.tracker_summary()
    cam_summary = summary.get("solotest-townhall", {})

    result = {
        "video": video_path,
        "elapsed_sec": round(elapsed, 1),
        "sample_every_n": SAMPLE_EVERY_N,
        "final_metrics_report": final_report,
        "tracker_summary": cam_summary,
    }
    with open(RESULTS_PATH, "w") as f:
        json.dump(result, f, indent=2)

    print(f"\n=== DONE in {elapsed/3600:.2f}h ===")
    print("final_metrics_report:", json.dumps(final_report, indent=2))
    print(f"vehicles_tracked={cam_summary.get('vehicles_tracked', 0)} "
          f"plate_candidates={cam_summary.get('plate_candidates', 0)} "
          f"confirmed={len(cam_summary.get('confirmed_plates', []))} "
          f"tiers={cam_summary.get('confirmed_by_tier', {})}")
    print(f"\nResults: {RESULTS_PATH}\nGPU log: {GPU_LOG_PATH}\nSys log: {SYS_LOG_PATH}")


if __name__ == "__main__":
    main()
