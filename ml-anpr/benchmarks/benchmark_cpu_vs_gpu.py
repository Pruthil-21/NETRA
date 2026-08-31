"""CPU vs GPU latency benchmark for the three torch/paddle models in the
ANPR pipeline (YOLOv8n detection, NAFNet deblur, PaddleOCR text read),
against the static ground-truth test images only (no video/RTSP).

Run directly: `python benchmarks/benchmark_cpu_vs_gpu.py` from ml-anpr/.
Requires a CUDA GPU to be present -- prints a CPU-only table and skips
the GPU columns otherwise.
"""
import os
import sys
import time

import cv2
import torch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ultralytics import YOLO  # noqa: E402
from nafnet.NAFNet_arch import NAFNetLocal  # noqa: E402
from anpr.enhancement import _NAFNET_CHECKPOINT_PATH, _NAFNET_CHECKPOINT_URL  # noqa: E402
from anpr.config import _gpu_ocr_client, _cpu_ocr_client  # noqa: E402

TEST_IMAGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_images"))
DEGRADED_IMAGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_images_degraded"))
YOLO_WEIGHTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "yolov8n.pt"))

CLEAN_IMAGES = ["car1.jpg", "car2.jpg", "car3.jpg"]
BLURRY_IMAGES = ["car1_motionblur.jpg", "car2_motionblur.jpg", "car3_motionblur.jpg"]

WARMUP_RUNS = 2
TIMED_RUNS = 10

CUDA_AVAILABLE = torch.cuda.is_available()


def _time_calls(fn, n):
    for _ in range(WARMUP_RUNS):
        fn()
    if CUDA_AVAILABLE:
        torch.cuda.synchronize()
    t0 = time.perf_counter()
    for _ in range(n):
        fn()
    if CUDA_AVAILABLE:
        torch.cuda.synchronize()
    return (time.perf_counter() - t0) / n * 1000  # ms/call


def print_table(title, rows, headers):
    print(f"\n{title}")
    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) for i, h in enumerate(headers)]
    line = " | ".join(h.ljust(w) for h, w in zip(headers, widths))
    print(line)
    print("-" * len(line))
    for r in rows:
        print(" | ".join(str(c).ljust(w) for c, w in zip(r, widths)))


def bench_yolo():
    images = {name: cv2.imread(os.path.join(TEST_IMAGES_DIR, name)) for name in CLEAN_IMAGES}
    model_cpu = YOLO(YOLO_WEIGHTS)
    model_cpu.to("cpu")
    model_gpu = YOLO(YOLO_WEIGHTS).to("cuda") if CUDA_AVAILABLE else None

    rows = []
    for name, img in images.items():
        cpu_ms = _time_calls(lambda img=img: model_cpu(img, verbose=False), TIMED_RUNS)
        if CUDA_AVAILABLE:
            gpu_ms = _time_calls(lambda img=img: model_gpu(img, verbose=False), TIMED_RUNS)
            rows.append((name, f"{cpu_ms:.1f}", f"{gpu_ms:.1f}", f"{cpu_ms / gpu_ms:.2f}x"))
        else:
            rows.append((name, f"{cpu_ms:.1f}", "n/a", "n/a"))
    return rows


def bench_nafnet():
    if not os.path.exists(_NAFNET_CHECKPOINT_PATH):
        import requests
        os.makedirs(os.path.dirname(_NAFNET_CHECKPOINT_PATH), exist_ok=True)
        resp = requests.get(_NAFNET_CHECKPOINT_URL, timeout=60)
        resp.raise_for_status()
        with open(_NAFNET_CHECKPOINT_PATH, "wb") as f:
            f.write(resp.content)

    checkpoint = torch.load(_NAFNET_CHECKPOINT_PATH, map_location="cpu")

    def build(device):
        m = NAFNetLocal(
            img_channel=3, width=32, enc_blk_nums=[1, 1, 1, 28], middle_blk_num=1,
            dec_blk_nums=[1, 1, 1, 1], train_size=(1, 3, 256, 256), fast_imp=True,
        )
        m.load_state_dict(checkpoint["params"])
        m.eval()
        m.to(device)
        return m

    model_cpu = build("cpu")
    model_gpu = build("cuda") if CUDA_AVAILABLE else None

    def run(model, device, img_rgb):
        tensor = torch.from_numpy(img_rgb).permute(2, 0, 1).unsqueeze(0).to(device)
        with torch.no_grad():
            model(tensor)

    rows = []
    for name in BLURRY_IMAGES:
        img = cv2.imread(os.path.join(DEGRADED_IMAGES_DIR, name))
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype("float32") / 255.0

        cpu_ms = _time_calls(lambda img_rgb=img_rgb: run(model_cpu, "cpu", img_rgb), TIMED_RUNS)
        if CUDA_AVAILABLE:
            gpu_ms = _time_calls(lambda img_rgb=img_rgb: run(model_gpu, "cuda", img_rgb), TIMED_RUNS)
            rows.append((name, f"{cpu_ms:.1f}", f"{gpu_ms:.1f}", f"{cpu_ms / gpu_ms:.2f}x"))
        else:
            rows.append((name, f"{cpu_ms:.1f}", "n/a", "n/a"))
    return rows


def bench_ocr():
    # Real plate crops, not full images: run YOLO once (GPU if available)
    # to get each clean image's vehicle box, then crop the plate band the
    # same way the real pipeline does before handing it to OCR.
    from anpr.detection import plate_region_crop
    detector = YOLO(YOLO_WEIGHTS).to("cuda" if CUDA_AVAILABLE else "cpu")

    crops = {}
    for name in CLEAN_IMAGES:
        img = cv2.imread(os.path.join(TEST_IMAGES_DIR, name))
        results = detector(img, verbose=False)
        vehicle_classes = {2, 3, 5, 7}
        box = None
        for r in results:
            for b in r.boxes:
                if int(b.cls[0]) in vehicle_classes:
                    box = tuple(map(int, b.xyxy[0]))
                    break
            if box:
                break
        vehicle_img = img[box[1]:box[3], box[0]:box[2]] if box else img
        crops[name] = plate_region_crop(vehicle_img) if plate_region_crop(vehicle_img) is not None else vehicle_img

    rows = []
    for name, crop in crops.items():
        cpu_ms = _time_calls(lambda crop=crop: _cpu_ocr_client.read(crop), TIMED_RUNS)
        if _gpu_ocr_client is not None:
            gpu_ms = _time_calls(lambda crop=crop: _gpu_ocr_client.read(crop), TIMED_RUNS)
            rows.append((name, f"{cpu_ms:.1f}", f"{gpu_ms:.1f}", f"{cpu_ms / gpu_ms:.2f}x"))
        else:
            rows.append((name, f"{cpu_ms:.1f}", "n/a", "n/a"))
    return rows


if __name__ == "__main__":
    print(f"CUDA available: {CUDA_AVAILABLE}"
          f" ({torch.cuda.get_device_name(0)})" if CUDA_AVAILABLE else "CUDA available: False")
    print(f"Runs per image: {TIMED_RUNS} (+ {WARMUP_RUNS} warmup, excluded)")

    headers = ["image", "cpu ms/call", "gpu ms/call", "speedup"]

    yolo_rows = bench_yolo()
    print_table("YOLOv8n vehicle detection", yolo_rows, headers)

    nafnet_rows = bench_nafnet()
    print_table("NAFNet motion-deblur", nafnet_rows, headers)

    ocr_rows = bench_ocr()
    print_table("PaddleOCR plate read", ocr_rows, headers)

    def avg_speedup(rows):
        vals = [float(r[3].rstrip("x")) for r in rows if r[3] != "n/a"]
        return sum(vals) / len(vals) if vals else None

    print("\nSummary (avg speedup across test images)")
    summary_headers = ["stage", "avg speedup (GPU vs CPU)"]
    summary_rows = [
        ("YOLOv8n detection", f"{avg_speedup(yolo_rows):.2f}x" if avg_speedup(yolo_rows) else "n/a"),
        ("NAFNet deblur", f"{avg_speedup(nafnet_rows):.2f}x" if avg_speedup(nafnet_rows) else "n/a"),
        ("PaddleOCR read", f"{avg_speedup(ocr_rows):.2f}x" if avg_speedup(ocr_rows) else "n/a"),
    ]
    print_table("", summary_rows, summary_headers)
