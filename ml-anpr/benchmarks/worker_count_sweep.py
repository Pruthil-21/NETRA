"""Worker-count sweep: same camera set, sequential phases at different
num_workers, to find the real throughput/latency sweet spot for this
GPU+CPU combination. Prior tests only measured the two extremes (1
worker/1 camera solo, 6 workers/6 cameras all-in) -- this fills in the
middle so a real "how many cameras can this server run well" answer is
possible instead of guessing between two data points.

Each phase gets a fresh ScalablePipeline (no state carried over from the
previous phase's trackers) so every worker-count is measured on equal
footing. Same self-launching GPU (nvidia-smi) and CPU/memory (/proc)
monitors as solo_hardcore_test.py, running continuously across the whole
sweep so the full timeline can be sliced by phase afterward.

Run from the repo root: `python benchmarks/worker_count_sweep.py`.
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

WORKER_COUNTS = [1, 2, 3, 4, 5, 6]
PHASE_DURATION_SEC = 12 * 60
REPORT_INTERVAL_SEC = 60
SAMPLE_EVERY_N = 10
SYS_LOG_INTERVAL_SEC = 15
MAX_CAMERAS = 6

GPU_LOG_PATH = os.path.join(REPO_ROOT, "sweep_gpu_log.csv")
SYS_LOG_PATH = os.path.join(REPO_ROOT, "sweep_sys_log.csv")
RESULTS_PATH = os.path.join(REPO_ROOT, "sweep_results.json")


def find_videos():
    search_dirs = [
        os.path.expanduser("~/eval_videos"),
        os.path.expanduser("~"),
        REPO_ROOT,
        "/tmp",
        "/bkp/NETRA/data/eval_videos",
        "/bkp/NETRA/data/test-videos",
    ]
    patterns = ["*.mp4", "*.MP4", "*.avi", "*.AVI"]
    found = []
    for d in search_dirs:
        if not os.path.isdir(d):
            continue
        for pat in patterns:
            found.extend(glob.glob(os.path.join(d, pat)))
    seen, videos = set(), []
    for f in found:
        real = os.path.realpath(f)
        if real not in seen:
            seen.add(real)
            videos.append(f)
    return videos[:MAX_CAMERAS]


def start_gpu_logger():
    """Same pattern as solo_hardcore_test.py's -- nvidia-smi as its own
    subprocess, killed explicitly at the very end of the whole sweep."""
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
    """Same as solo_hardcore_test.py's -- runs once, continuously, for
    the whole sweep (not restarted per phase) so the timeline can be
    correlated against phase boundaries afterward via timestamp."""
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

    videos = find_videos()
    if len(videos) < 2:
        print(f"ERROR: only found {len(videos)} video file(s). Need at least 2 for a meaningful sweep.")
        sys.exit(1)

    print(f"Using {len(videos)} camera(s):")
    for v in videos:
        print(f"  {v}")

    gpu_proc = start_gpu_logger()
    stop_sys = threading.Event()
    sys_thread = threading.Thread(target=sys_monitor_loop, args=(stop_sys,), daemon=True)
    sys_thread.start()
    print(f"GPU log -> {GPU_LOG_PATH}\nSys log -> {SYS_LOG_PATH}")

    all_results = []
    sweep_t0 = time.time()
    for n in WORKER_COUNTS:
        # Deliberately NOT "direct-camNN" ids -- see hardcore_test.py's
        # same comment; unmapped ids run real inference but never reach
        # the real backend.
        cameras = [(f"sweep-cam{i}", v) for i, v in enumerate(videos, 1)]
        print(f"\n=== PHASE: num_workers={n} (cameras={len(cameras)}, "
              f"phase_duration={PHASE_DURATION_SEC}s) ===")
        pipeline = ScalablePipeline(cameras, num_workers=n, sample_every_n=SAMPLE_EVERY_N)
        phase_t0 = time.time()
        report = pipeline.run_for(duration_sec=PHASE_DURATION_SEC, report_interval_sec=REPORT_INTERVAL_SEC)
        phase_elapsed = time.time() - phase_t0
        summary = pipeline.tracker_summary()

        total_vehicles = sum(c.get("vehicles_tracked", 0) for c in summary.values())
        total_candidates = sum(c.get("plate_candidates", 0) for c in summary.values())
        total_confirmed = sum(len(c.get("confirmed_plates", [])) for c in summary.values())

        phase_result = {
            "num_workers": n,
            "num_cameras": len(cameras),
            "phase_elapsed_sec": round(phase_elapsed, 1),
            "final_metrics_report": report,
            "per_camera_summary": summary,
            "totals": {
                "total_vehicles_tracked": total_vehicles,
                "total_plate_candidates": total_candidates,
                "total_confirmed_plates": total_confirmed,
            },
        }
        all_results.append(phase_result)
        # write incrementally -- a later phase crashing shouldn't lose
        # every earlier phase's real results
        with open(RESULTS_PATH, "w") as f:
            json.dump(all_results, f, indent=2)

        print(f"phase done: fps={report['frame_throughput_per_sec']} "
              f"latency_avg_ms={report['inference_latency_avg_ms']} "
              f"latency_p95_ms={report['inference_latency_p95_ms']} "
              f"frames_processed={report['frames_processed']} "
              f"confirmed_plates={total_confirmed}")

        # Every prior test in this project created exactly one
        # ScalablePipeline per process lifetime, so any lingering
        # multiprocessing.Queue feeder-thread cleanup was masked by the
        # process exiting right after. Creating several sequentially in
        # one process (this sweep) exposed real, if harmless, noise:
        # BrokenPipeError tracebacks from a previous phase's queue
        # feeder thread still flushing after that phase's worker
        # process already terminated. Doesn't corrupt results (each
        # phase's real numbers are already written to disk above by the
        # time this runs) -- this pause just gives that cleanup wall-
        # clock time to finish quietly before the next phase's own
        # processes/queues start competing for attention.
        del pipeline
        time.sleep(3)

    stop_sys.set()
    sys_thread.join(timeout=5)
    if gpu_proc is not None:
        gpu_proc.terminate()

    sweep_elapsed = time.time() - sweep_t0
    print(f"\n=== SWEEP DONE in {sweep_elapsed/60:.1f} min ===")
    print(f"{'workers':>8} {'fps':>8} {'lat_avg_ms':>11} {'lat_p95_ms':>11} "
          f"{'processed':>10} {'confirmed':>10}")
    for r in all_results:
        rep = r["final_metrics_report"]
        print(f"{r['num_workers']:>8} {rep['frame_throughput_per_sec']:>8} "
              f"{rep['inference_latency_avg_ms']:>11} {rep['inference_latency_p95_ms']:>11} "
              f"{rep['frames_processed']:>10} {r['totals']['total_confirmed_plates']:>10}")
    print(f"\nFull results: {RESULTS_PATH}\nGPU log: {GPU_LOG_PATH}\nSys log: {SYS_LOG_PATH}")


if __name__ == "__main__":
    main()
