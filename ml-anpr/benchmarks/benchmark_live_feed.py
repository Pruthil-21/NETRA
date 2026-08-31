"""CPU vs GPU benchmark against the LIVE vehicle-trace RTSP streams
(cameras 101/102/103, Dhruv's Mac over Tailscale) -- reads real plates for
a fixed duration per camera and reports per-frame latency, plate reads,
confidence, and accuracy against the known scenario target plate.

Run directly: `python benchmarks/benchmark_live_feed.py --device gpu|cpu
[--host 100.105.88.26] [--cameras 101,102,103] [--duration 20]`

--device cpu disables CUDA (CUDA_VISIBLE_DEVICES="") before anything else
is imported, so YOLO/NAFNet/OCR all fall back to their CPU paths the same
way the rest of the pipeline would on a GPU-less machine -- this must
happen before `import torch`, hence the env var is set at the very top of
main(), ahead of every other import in this file.
"""
import argparse
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["gpu", "cpu"], required=True)
    parser.add_argument("--host", default="100.105.88.26")
    parser.add_argument("--cameras", default="101,102,103")
    parser.add_argument("--duration", type=float, default=20.0, help="seconds per camera")
    parser.add_argument("--process-every-n-frames", type=int, default=5)
    parser.add_argument("--target-plate", default="GX15OGJ")
    parser.add_argument("--transport", choices=["rtsp", "hls"], default="rtsp",
                         help="hls: for organizer cameras only exposed via the HLS relay, no local RTSP path")
    parser.add_argument("--hls-base", default=None,
                         help="Base HLS URL, e.g. https://<tunnel>.trycloudflare.com (required for --transport hls)")
    args = parser.parse_args()

    if args.device == "cpu":
        # "-1" (not "") reliably hides all GPUs from torch on Windows --
        # empty string left torch.cuda.is_available() returning True with
        # device_count() 0, which crashed ultralytics' device selection.
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    import cv2  # noqa: E402
    import detect_plate  # noqa: E402
    from streaming.rtsp_reader import RTSPStreamReader  # noqa: E402

    if args.transport == "hls" and not args.hls_base:
        parser.error("--hls-base is required with --transport hls")

    cameras = [c.strip() for c in args.cameras.split(",") if c.strip()]
    all_rows = []

    def process_frame(cam_id, infer_frame, raw_frame):
        t0 = time.perf_counter()
        results = detect_plate.detect_plate_from_frame(infer_frame, raw_frame)
        latency_ms = (time.perf_counter() - t0) * 1000
        for r in results:
            plate = r.get("plate_number")
            conf = r.get("confidence", 0)
            note = r.get("note")
            match = detect_plate._plate_similarity(plate, args.target_plate) if plate and args.target_plate else 0.0
            all_rows.append({
                "camera": cam_id, "latency_ms": latency_ms,
                "plate": plate, "confidence": conf, "note": note,
                "target_match_score": match,
            })
            if plate:
                extra = f" match={match:.2f}" if args.target_plate else ""
                print(f"  [{latency_ms:.0f}ms] plate={plate} conf={conf}{extra} note={note}", flush=True)

    for cam_id in cameras:
        frame_count = 0
        if args.transport == "rtsp":
            url = f"rtsp://{args.host}:8554/stream/{cam_id}"
            print(f"\n[{args.device.upper()}] connecting (RTSP) to camera {cam_id}: {url}", flush=True)
            try:
                stream = RTSPStreamReader(rtsp_url=url, inference_dim=(640, 360)).start()
            except Exception as e:
                print(f"  connect failed: {e}")
                continue

            deadline = time.time() + args.duration
            try:
                while time.time() < deadline:
                    ready, raw_frame, infer_frame = stream.read_latest()
                    if not ready:
                        time.sleep(0.05)
                        continue
                    frame_count += 1
                    if frame_count % args.process_every_n_frames != 0:
                        continue
                    process_frame(cam_id, infer_frame, raw_frame)
            finally:
                stream.stop()
        else:
            url = f"{args.hls_base.rstrip('/')}/stream/{cam_id}/index.m3u8"
            print(f"\n[{args.device.upper()}] connecting (HLS) to camera {cam_id}: {url}", flush=True)
            cap = cv2.VideoCapture(url)
            if not cap.isOpened():
                print("  connect failed")
                cap.release()
                continue

            deadline = time.time() + args.duration
            try:
                while time.time() < deadline:
                    ret, frame = cap.read()
                    if not ret:
                        time.sleep(0.05)
                        continue
                    frame_count += 1
                    if frame_count % args.process_every_n_frames != 0:
                        continue
                    process_frame(cam_id, frame, frame)
            finally:
                cap.release()

    if not all_rows:
        print("\nNo frames processed at all (stream unreachable?) -- nothing to report.")
        return

    processed = len(all_rows)
    with_plate = [r for r in all_rows if r["plate"]]
    target_matches = [r for r in with_plate if r["target_match_score"] >= 0.7]
    avg_latency = sum(r["latency_ms"] for r in all_rows) / processed
    avg_conf = sum(r["confidence"] for r in with_plate) / len(with_plate) if with_plate else 0

    print(f"\n=== {args.device.upper()} plate reads ===")
    print(f"{'camera':<8} | {'plate':<12} | {'confidence':<10} | note")
    for r in with_plate:
        print(f"{r['camera']:<8} | {r['plate']:<12} | {r['confidence']:<10} | {r['note']}")

    print(f"\n=== {args.device.upper()} summary ===")
    print(f"vehicle-boxes processed: {processed}")
    print(f"boxes with a plate read: {len(with_plate)} ({100 * len(with_plate) / processed:.1f}%)")
    if args.target_plate:
        print(f"reads matching target plate ({args.target_plate}, similarity>=0.7): "
              f"{len(target_matches)} ({100 * len(target_matches) / max(1, len(with_plate)):.1f}% of reads)")
    print(f"avg end-to-end latency per vehicle box: {avg_latency:.1f}ms")
    print(f"avg OCR confidence (successful reads only): {avg_conf:.3f}")


if __name__ == "__main__":
    main()
