"""
PaddleOCR, isolated in its own OS process via subprocess.Popen (not
multiprocessing).

Reproduced directly: paddlepaddle-gpu and torch cannot be imported in the
same Windows process, GPU or CPU device param -- both bundle same-named,
differently-versioned CUDA DLLs (cudnn_cnn64_9.dll etc.), and once
paddlepaddle-gpu is the installed package, importing `paddle` at all
unconditionally loads them, colliding with torch's own copies if torch
already loaded first (or vice versa) in that process.

multiprocessing.Process (spawn) does NOT give real isolation here: on
Windows, spawn re-executes the entire calling script's top-level code in
the child (to reconstruct __main__ for unpickling) -- so if the caller's
own script (or anything it imports, like detect_plate.py) does `import
torch` at module level, that import runs again in the "isolated" child
before the worker function ever gets to import paddle. Verified directly:
switching from multiprocessing to a plain subprocess.Popen of this file
as its own script (a genuinely separate `python ocr_gpu_worker.py`
process, with no knowledge of the parent's module tree at all) is what
actually fixes it.

Protocol (parent <-> child, both directions length-prefixed):
    4-byte big-endian length, then that many bytes.
    Parent -> child: PNG-encoded image bytes, or b"" to shut down.
    Child -> parent: JSON bytes, {"status": "ok", "pairs": [[text, conf], ...]}
                                | {"status": "error", "detail": "..."}
Chosen over multiprocessing.Queue/pickle specifically to avoid any
dependency on the multiprocessing spawn machinery above.
"""
import json
import os
import struct
import subprocess
import sys

_NVIDIA_DLL_SUBDIRS = [
    "cuda_runtime/bin", "cublas/bin", "cusparse/bin", "cusolver/bin",
    "curand/bin", "cufft/bin", "nvjitlink/bin", "cudnn/bin",
]

STARTUP_TIMEOUT_S = 120
CALL_TIMEOUT_S = 30


def _register_nvidia_dll_dirs():
    if sys.platform != "win32":
        return
    import importlib.util
    spec = importlib.util.find_spec("nvidia")
    if spec is None or not spec.submodule_search_locations:
        return
    base = list(spec.submodule_search_locations)[0]
    for sub in _NVIDIA_DLL_SUBDIRS:
        full = os.path.join(base, sub)
        if os.path.isdir(full):
            os.add_dll_directory(full)


def _write_frame(stream, payload: bytes):
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def _read_frame(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack(">I", header)
    if length == 0:
        return b""
    return stream.read(length)


def _serve():
    """Runs when this file is executed directly (python ocr_gpu_worker.py
    --device gpu|cpu) -- a real, standalone process, never imported by
    detect_plate.py, so it never inherits torch from a parent's module
    tree."""
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["gpu", "cpu"], required=True)
    args = parser.parse_args()

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    try:
        import cv2
        import numpy as np
        # Import order matters: paddleocr's own import chain (paddlex ->
        # official_models -> modelscope) unconditionally does `import
        # torch` internally, before paddle itself is ever touched. Adding
        # paddle's nvidia/*/bin DLL directories to the search path BEFORE
        # that happens pollutes it for torch's own DLL loading too --
        # verified directly: torch's bundled shm.dll then fails to load
        # with the same WinError 127 shape. Importing paddleocr first lets
        # torch's internal import finish cleanly against an unpolluted
        # search path; paddle's own CUDA init is lazy (deferred to
        # PaddleOCR(...) construction below), so registering the
        # directories right before that point still works.
        from paddleocr import PaddleOCR
        _register_nvidia_dll_dirs()

        kwargs = {"use_angle_cls": True, "lang": "en", "device": args.device}
        if args.device == "cpu":
            kwargs["enable_mkldnn"] = False  # known Windows PIR/oneDNN crash fix
        ocr = PaddleOCR(**kwargs)
    except Exception as exc:  # noqa: BLE001
        _write_frame(stdout, json.dumps({"status": "startup_error", "detail": str(exc)}).encode())
        return

    _write_frame(stdout, json.dumps({"status": "ready"}).encode())

    while True:
        frame = _read_frame(stdin)
        if frame is None or frame == b"":
            break
        try:
            arr = np.frombuffer(frame, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            results = ocr.predict(img)
            pairs = [
                [text, conf]
                for r in results
                for text, conf in zip(r.get("rec_texts", []), r.get("rec_scores", []))
            ]
            _write_frame(stdout, json.dumps({"status": "ok", "pairs": pairs}).encode())
        except Exception as exc:  # noqa: BLE001
            _write_frame(stdout, json.dumps({"status": "error", "detail": str(exc)}).encode())


class GpuOcrClient:
    """Lazily starts the OCR worker process on first use -- same lazy-init
    pattern as detect_plate.py's NAFNet loader, since most call sites
    don't run for the whole process lifetime. device='cpu' still runs in
    its own isolated process (see module docstring) -- this class isn't
    GPU-specific, just process-isolated PaddleOCR."""

    def __init__(self, device="gpu"):
        self._device = device
        self._proc = None
        self._unavailable = False

    def _worker_python(self):
        """A separate venv (.venv-ocr, sibling to this file) with its own
        CPU-only torch, so paddleocr's internal `import torch` (via
        modelscope) never touches the main venv's CUDA torch. Windows-only
        problem -- falls back to sys.executable (the caller's own venv)
        when that dedicated venv doesn't exist, e.g. on a platform where
        torch/paddle don't collide, or if it just hasn't been set up."""
        here = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.join(here, ".venv-ocr", "Scripts", "python.exe")
        return candidate if os.path.isfile(candidate) else sys.executable

    def _ensure_started(self):
        if self._unavailable:
            raise RuntimeError(f"{self._device} OCR worker previously failed to start")
        if self._proc is not None and self._proc.poll() is None:
            return
        self._proc = subprocess.Popen(
            [self._worker_python(), os.path.abspath(__file__), "--device", self._device],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        # Startup (model load, or a real failure) can legitimately take a
        # while -- see STARTUP_TIMEOUT_S. No portable per-call timeout on
        # a blocking pipe read without extra plumbing, so a hung child
        # here surfaces as a hang, not a clean error -- acceptable for
        # this demo script, not for production use.
        frame = _read_frame(self._proc.stdout)
        if frame is None:
            stderr = self._proc.stderr.read().decode(errors="replace")
            self._unavailable = True
            raise RuntimeError(f"{self._device} OCR worker exited before ready: {stderr[-2000:]}")
        payload = json.loads(frame)
        if payload.get("status") != "ready":
            self._unavailable = True
            raise RuntimeError(f"{self._device} OCR worker failed to start: {payload.get('detail')}")

    def read(self, img):
        """Returns [(text, confidence), ...] for every detected text
        region -- matches detect_plate.py's _ocr_readtext aggregation."""
        import cv2

        self._ensure_started()
        ok, encoded = cv2.imencode(".png", img)
        if not ok:
            raise RuntimeError("failed to encode crop for OCR worker")
        _write_frame(self._proc.stdin, encoded.tobytes())
        frame = _read_frame(self._proc.stdout)
        if frame is None:
            stderr = self._proc.stderr.read().decode(errors="replace")
            self._unavailable = True
            raise RuntimeError(f"{self._device} OCR worker died mid-call: {stderr[-2000:]}")
        payload = json.loads(frame)
        if payload.get("status") == "error":
            raise RuntimeError(f"{self._device} OCR worker error: {payload.get('detail')}")
        return [(p[0], p[1]) for p in payload["pairs"]]

    def shutdown(self):
        if self._proc is not None and self._proc.poll() is None:
            try:
                _write_frame(self._proc.stdin, b"")
                self._proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                self._proc.kill()


if __name__ == "__main__":
    _serve()
