"""CPU vs GPU benchmark against a real dashcam video (not a live stream) --
samples frames evenly across the whole clip so both passes see the same
content regardless of how fast each device runs, detects every plate it
can, and clusters OCR variants of the same physical plate together (same
fuzzy-match algorithm/threshold the live pipeline already uses) so the
summary reports distinct vehicles, not raw noisy re-reads.

Run directly: `python benchmarks/benchmark_dashcam_video.py --device gpu|cpu
--video "C:\\path\\to\\video.mp4"` [--sample-frames 45]

--device cpu disables CUDA (CUDA_VISIBLE_DEVICES=-1) before anything else
is imported, so YOLO/NAFNet/OCR all fall back to CPU the same way the rest
of the pipeline would on a GPU-less machine.
"""
import argparse
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["gpu", "cpu"], required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--sample-frames", type=int, default=45,
                         help="Frames sampled evenly across the whole clip (bounds total work).")
    args = parser.parse_args()

    if args.device == "cpu":
        # "-1" (not "") reliably hides all GPUs from torch on Windows.
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    import cv2  # noqa: E402
    import detect_plate  # noqa: E402

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Failed to open video: {args.video}")
        return

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, total_frames // args.sample_frames)
    frame_indices = list(range(0, total_frames, step))[: args.sample_frames]

    print(f"[{args.device.upper()}] video: {args.video}")
    print(f"  {total_frames} frames @ {fps:.1f}fps ({total_frames / fps:.1f}s) -- "
          f"sampling {len(frame_indices)} frames (every {step}th)")

    all_rows = []
    t_start = time.perf_counter()
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue

        t0 = time.perf_counter()
        results = detect_plate.detect_plate_from_frame(frame, frame)
        latency_ms = (time.perf_counter() - t0) * 1000

        for r in results:
            plate = r.get("plate_number")
            conf = r.get("confidence", 0)
            note = r.get("note")
            all_rows.append({
                "frame": idx, "timestamp_s": round(idx / fps, 1),
                "latency_ms": latency_ms, "plate": plate, "confidence": conf, "note": note,
            })
            if plate:
                print(f"  [frame {idx:>5} @ {idx / fps:5.1f}s, {latency_ms:6.0f}ms] "
                      f"plate={plate:<12} conf={conf} note={note}", flush=True)
    cap.release()
    total_elapsed = time.perf_counter() - t_start

    if not all_rows:
        print("\nNo frames processed -- nothing to report.")
        return

    with_plate = [r for r in all_rows if r["plate"]]
    avg_latency = sum(r["latency_ms"] for r in all_rows) / len(all_rows)
    avg_conf = sum(r["confidence"] for r in with_plate) / len(with_plate) if with_plate else 0

    # Cluster OCR variants of the same physical plate together, same fuzzy
    # algorithm/threshold detect_plate.py's own tracker uses.
    clusters = []  # each: {"reads": [row, ...]}
    for row in with_plate:
        placed = False
        for cluster in clusters:
            rep = cluster["reads"][0]["plate"]
            if detect_plate._plate_similarity(row["plate"], rep) >= 0.7:
                cluster["reads"].append(row)
                placed = True
                break
        if not placed:
            clusters.append({"reads": [row]})

    print(f"\n=== {args.device.upper()} summary ===")
    print(f"frames sampled: {len(frame_indices)}")
    print(f"vehicle-boxes processed: {len(all_rows)}")
    print(f"boxes with a plate read: {len(with_plate)} ({100 * len(with_plate) / len(all_rows):.1f}%)")
    print(f"distinct vehicles (clustered): {len(clusters)}")
    print(f"avg latency per vehicle-box: {avg_latency:.1f}ms")
    print(f"avg OCR confidence (successful reads): {avg_conf:.3f}")
    print(f"total wall time: {total_elapsed:.1f}s")

    print(f"\n=== {args.device.upper()} distinct vehicles ===")
    print(f"{'plate (best read)':<14} | {'confidence':<10} | {'variants seen':<8} | {'first seen':<10} | other spellings")
    for cluster in sorted(clusters, key=lambda c: -len(c["reads"])):
        best = max(cluster["reads"], key=lambda r: r["confidence"])
        variants = sorted(set(r["plate"] for r in cluster["reads"]))
        others = [v for v in variants if v != best["plate"]]
        print(f"{best['plate']:<14} | {best['confidence']:<10} | {len(cluster['reads']):<13} | "
              f"{best['timestamp_s']:<10} | {', '.join(others) if others else '-'}")


if __name__ == "__main__":
    main()
