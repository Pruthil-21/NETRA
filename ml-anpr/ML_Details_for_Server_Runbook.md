# ML Details for the NETRA Dual-GPU Server Runbook

Fills in the "Five ML details cannot be guessed safely" table from
`NETRA_Dual_GPU_Server_Runbook.pdf` Section 1.1, plus everything else in
that runbook that's specific to the ml-anpr pipeline. Everything below
is a real, current value from this repo — not invented.

## The 5 required values

| Value | Real answer |
|---|---|
| `AVI_BRANCH` | `feature/plate-region-detector` — **not `main`**. This branch has today's work (VLM fallback, overlay fix, scalable pipeline) and is not yet merged. Check out this branch specifically, not `main`. |
| `AVI_PYTHON_VERSION` | **3.9** — not 3.10/3.11 as the runbook's example suggested. The whole pipeline (venv, PaddleOCR, torch/ultralytics versions in `requirements.txt`) is tested against 3.9. |
| `AVI_REQUIREMENTS` | `ml-anpr/requirements.txt` — **but installing it isn't a single step**, see "Known install-order gotcha" below. |
| `AVI_ENTRYPOINT` | There's no pre-existing single-file CLI script — the pipeline is normally used via Python function calls. A real CLI wrapper (`ml-anpr/run_inference.py`) was written and tested today specifically so the runbook's `--source`/`--device`-style commands work. See "Real entrypoint" below. |
| `AVI_CHECKPOINT` | **Not one file.** Three separate pieces — `yolov8n.pt`, PaddleOCR's own auto-downloaded weights, and (optional) a local Ollama model for the VLM fallback. See "What 'checkpoint' actually means here" below. |

## GPU 0 reservation — already correct in the runbook, confirming it

The runbook's own resource table already assigns **GPU 0 to Avi's model
training and inference only**, GPU 1 to streaming. This matches exactly
what was needed — nothing to change here, just confirming it's already
right in the source document. `export CUDA_VISIBLE_DEVICES=0` (as the
runbook already shows in Section 2.1) is the correct, sufficient way to
enforce this — the pipeline's own device-selection code
(`anpr/config.py`) auto-detects CUDA and will pick it up as `cuda:0`
automatically once that variable is set before Python starts. No code
change needed for this part.

## Known install-order gotcha (real, documented in `requirements.txt` itself)

```bash
pip install -r requirements.txt
pip install --force-reinstall opencv-python==5.0.0.93
```

Installing `paddleocr`/`paddlepaddle` pulls in `opencv-contrib-python`
as a side effect, which silently shadows `opencv-python` and changes
`cv2.__version__` — this measurably changed image decode/resize
behavior and regressed OCR accuracy when this was first discovered.
**Always reinstall `opencv-python==5.0.0.93` last, after everything
else.** Verify with:

```bash
python -c "import cv2; print(cv2.__version__)"   # must print 5.0.0
```

## GPU-accelerated OCR needs one extra package, not just `requirements.txt`

`requirements.txt` pins plain `paddlepaddle==3.3.1` — the **CPU**
package. For PaddleOCR to actually use the GPU, `paddlepaddle-gpu`
needs to be installed instead (matching the installed CUDA version).
This wasn't verified against this specific server's CUDA version today
— check PaddlePaddle's install selector for the right
`paddlepaddle-gpu` build once `nvidia-smi`'s CUDA version is known.
Without this, OCR will silently run on CPU even though YOLO is on the
GPU — not a crash, just slower than expected.

## The Windows-specific OCR isolation won't apply here

`ocr_gpu_worker.py` normally runs PaddleOCR in a separate, isolated
Python process because `paddlepaddle-gpu` and `torch` can't be imported
in the same **Windows** process (conflicting bundled CUDA DLLs). Read
directly in the source: this is explicitly a Windows-only problem, and
the code already falls back to using the same venv on other platforms.
On this Ubuntu server, expect this to just work without the `.venv-ocr`
workaround — but this hasn't been verified on Linux specifically, worth
confirming on first real run rather than assuming.

## Real entrypoint: `run_inference.py` (new, tested)

```bash
cd ml-anpr
python run_inference.py --source <path-to-video.mp4> --camera-id <name> --sample-rate 15
```

Wraps `anpr.streaming.process_video_file()` — the same, already-tested
function used throughout this whole project's development. `--source`
is a plain local file path, not a URL. There's no `--weights` flag,
because of the checkpoint situation below.

For the **scalable, multi-camera pipeline** (P3's handoff — separate
reader/inference/sender stages, worker pools, async delivery, metrics),
there's no CLI wrapper yet — it's used via
`anpr.pipeline.orchestrator.ScalablePipeline` directly in Python. See
`anpr/pipeline/orchestrator.py`'s docstring for the constructor
arguments (`cameras`, `num_workers`, `sample_every_n`, etc.) if this
needs to run standalone on the server; a CLI wrapper for this specific
piece can be built on request but wasn't part of today's build.

## What "checkpoint" actually means here (not one file)

1. **`yolov8n.pt`** — the vehicle detector. Already present at the repo
   root (`ml-anpr/yolov8n.pt`); `ultralytics` will also auto-download it
   on first run if it's ever missing. No manual setup needed.
2. **PaddleOCR's own weights** — downloaded automatically on first use
   into a local cache directory (not something this repo ships or
   manages). First run will be slower while this downloads; needs
   outbound internet access on the server for that first run.
3. **Optional: Ollama + `gemma3:4b`** — only needed for the local-AI
   last-resort fallback built today (`anpr/vlm_fallback.py`). Not
   required for the core pipeline to work. If you want this feature on
   the server: install Ollama, then `ollama pull gemma3:4b` (a real
   3.3GB download). Runs locally, no data leaves the server.

## How this connects to Section 18 of the runbook (staged pipeline / benchmark)

The runbook's Section 18 describes exactly what was built today for
P3's scalability ask: `anpr/pipeline/` — separate frame-reading,
inference-worker-pool, and async event-sending stages, with metrics,
retries, batching, and backpressure. Real measured numbers from this
machine (not the server): **~1,870-1,900 events/second sustained**,
independent of camera-identity count (1,000/10,000/80,000 all hit the
same ceiling) — this is the number the runbook's "Final presentation
statement" already quotes correctly. Re-running this same benchmark on
the server (`ml-anpr/benchmarks/synthetic_load_test.py`) would give a
real dual-GPU-server comparison point, per the runbook's own Section 18
suggestion to compare same-workload, same-duration results.
