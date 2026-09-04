"""Frame/crop quality gates (low-light, motion blur) and their matching
enhancers. Each gate is a cheap heuristic that decides whether the
expensive enhancer actually needs to run -- both thresholds are
calibrated against measured data, not guessed (see each docstring)."""
import os

import cv2
import requests
import torch

from .config import device

LOW_LIGHT_BRIGHTNESS_THRESHOLD = 50


def is_low_light(img):
    """
    Cheap (grayscale mean, no denoising) brightness check, so the
    expensive enhance_low_light() below only runs on frames that
    actually need it. Threshold calibrated directly against our own
    data, not guessed: the 3 clean ground-truth images measure
    97-119 mean brightness; their synthetically darkened counterparts
    measure 25-29; fog/glare variants measure 131-159 (brighter than
    clean, not darker). 50 sits in the middle of a wide, cleanly
    separated gap between the darkest normal frame and the brightest
    dark one in every case tested so far.
    """
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean() < LOW_LIGHT_BRIGHTNESS_THRESHOLD


def enhance_low_light(img):
    """
    Denoise-then-CLAHE (LAB L-channel) for low-light frames. Tested
    directly against the reason low-light detection was failing:
    plain gamma correction and CLAHE-alone both left YOLO finding zero
    vehicles in a synthetically darkened+noisy test frame (see
    ALPR_IMPROVEMENT_LOG.md Session 5) -- CLAHE alone amplifies sensor
    noise rather than recovering real detail. Denoising first, then
    CLAHE, recovered a real vehicle detection (0 -> 0.288 confidence),
    and didn't regress the 3 clean ground-truth images (still 3/3 at
    1.0 confidence with it applied).

    Gated behind is_low_light() in detection.detect_plate_from_frame, not
    called unconditionally -- fastNlMeansDenoisingColored is expensive
    enough that applying it to every frame (including well-lit ones that
    don't need it) measured a 2.5-3.6x end-to-end slowdown on the dashcam
    video regression (168-280s -> 608s for the same clip, Session 5).
    Gating it behind a cheap brightness check (Session 6) should recover
    the accuracy benefit on genuinely dark frames without paying that
    cost on the (presumably far more common) well-lit ones -- see
    ALPR_IMPROVEMENT_LOG.md Session 6 for the actual measured result on
    real video, not just the reasoning.
    """
    # fastNlMeansDenoisingColored is the real cost here, not CLAHE --
    # measured directly on a real 1920x1080 dark frame: 0.43s for denoise
    # alone vs 0.003s for CLAHE + color conversion combined.
    #
    # First attempt at speeding this up was downscaling the frame before
    # denoising and upscaling back (3.5x faster) -- rejected after real
    # testing found it shifts YOLO's detected box boundaries slightly
    # (a coarser full-frame image changes exactly where YOLO draws the
    # vehicle box), which on one real frame cost a previously-successful
    # plate read entirely (box moved just enough to crop the plate
    # differently). Spatial resolution matters for box precision, so
    # changing it was the wrong lever.
    #
    # searchWindowSize (last param, default 21) is NLM's own dominant
    # cost driver and, unlike resizing, doesn't touch spatial resolution
    # at all -- can't shift box positions the way resizing did. Single
    # static frames turned out too noisy to judge this by, though: one
    # specific hard frame with two vehicles gave a DIFFERENT partial
    # result (one vehicle read, the other not) at searchWindowSize=21,
    # =15, and =11 each -- three different outcomes from three parameter
    # choices on the same frame, meaning that frame sits right at an OCR
    # knife-edge for at least one vehicle regardless of this parameter.
    # Real validation is the same live-video, aggregate comparison used
    # for the raw+enhanced merge fix (see ALPR_IMPROVEMENT_LOG.md) --
    # trust the aggregate over any one frame's outcome.
    denoised = cv2.fastNlMeansDenoisingColored(img, None, 10, 10, 7, 15)
    lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l2 = clahe.apply(l)
    return cv2.cvtColor(cv2.merge((l2, a, b)), cv2.COLOR_LAB2BGR)


BLUR_LAPLACIAN_VARIANCE_THRESHOLD = 250

# Unlike low-light (a genuinely frame-wide property), motion blur is
# per-vehicle -- it depends on that specific vehicle's relative motion
# to the camera, not overall scene brightness. Checked per vehicle crop
# in detection._read_plate_from_box(), not once per frame like
# is_low_light().


def is_blurry(img):
    """
    Laplacian-variance blur heuristic, threshold calibrated against our
    own data (Session 10), not guessed: the 3 clean ground-truth images
    measure 685-1061; their synthetically motion-blurred counterparts
    measure 196-225 -- a clean gap. The one real risk found: fog-degraded
    images measure 279.8, closer to the blur range than to clean --
    250 sits below fog's value so fog doesn't trigger this gate (fog
    isn't motion blur, and NAFNet was only validated against motion
    blur), but the margin against fog specifically is real, not huge,
    and this is a whole-crop average so it can still be fooled by a
    partly-sharp, partly-blurred crop. Flagged as a real limitation,
    not asserted as fully robust.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var() < BLUR_LAPLACIAN_VARIANCE_THRESHOLD


_NAFNET_CACHE_DIR = os.path.expanduser("~/.cache/netra_nafnet")
_NAFNET_CHECKPOINT_PATH = os.path.join(_NAFNET_CACHE_DIR, "NAFNet-GoPro-width32.pth")
# Verified in Session 9 as a genuine direct download (HTTP redirect to a
# real CDN, matching Content-Length, no login wall) -- a community
# HuggingFace mirror of the official megvii-research checkpoint. Not
# committed to git (68MB); fetched once and cached on first use, same
# pattern PaddleOCR's own models already follow in this pipeline.
_NAFNET_CHECKPOINT_URL = "https://huggingface.co/nyanko7/nafnet-models/resolve/main/NAFNet-GoPro-width32.pth"

_nafnet_model = None
# Session 14: set once a checkpoint fetch fails, so a dead network
# doesn't get hammered with a fresh download attempt on every single
# blurry frame -- one failure per process lifetime is enough to give up.
_nafnet_unavailable = False


def _get_nafnet_model():
    """Lazily loads and caches the NAFNet model on first use, not at
    module import time -- most streams/images never hit the blur gate,
    so the ~68MB checkpoint fetch and model construction shouldn't cost
    anything unless a frame actually needs deblurring.

    Returns None (not an exception) if the checkpoint can't be fetched --
    see enhance_motion_blur() for the fallback this enables. Session 14:
    the download previously had no error handling at all, so a blurry
    frame on a machine with no cached checkpoint and no network access
    at that moment would crash the entire processing loop, not just skip
    that one frame's deblurring.
    """
    global _nafnet_model, _nafnet_unavailable
    if _nafnet_model is not None:
        return _nafnet_model
    if _nafnet_unavailable:
        return None

    from nafnet.NAFNet_arch import NAFNetLocal

    try:
        if not os.path.exists(_NAFNET_CHECKPOINT_PATH):
            os.makedirs(_NAFNET_CACHE_DIR, exist_ok=True)
            print(f"[nafnet] downloading checkpoint to {_NAFNET_CHECKPOINT_PATH} ...")
            response = requests.get(_NAFNET_CHECKPOINT_URL, timeout=60)
            response.raise_for_status()
            with open(_NAFNET_CHECKPOINT_PATH, "wb") as f:
                f.write(response.content)
    except requests.exceptions.RequestException as e:
        print(f"[WARN] NAFNet checkpoint unavailable ({e}), skipping deblur for this frame")
        if os.path.exists(_NAFNET_CHECKPOINT_PATH):
            os.remove(_NAFNET_CHECKPOINT_PATH)  # don't leave a partial/corrupt file cached
        _nafnet_unavailable = True
        return None

    model = NAFNetLocal(
        img_channel=3, width=32, enc_blk_nums=[1, 1, 1, 28], middle_blk_num=1,
        dec_blk_nums=[1, 1, 1, 1], train_size=(1, 3, 256, 256), fast_imp=True,
    )
    checkpoint = torch.load(_NAFNET_CHECKPOINT_PATH, map_location="cpu")
    model.load_state_dict(checkpoint["params"])
    model.eval()
    # Same device YOLO already uses (config.device, mps/cuda/cpu
    # auto-detected there) -- deblur is the other per-vehicle-crop torch
    # model in this pipeline, so it benefits from GPU the same way.
    model.to(device)
    _nafnet_model = model
    return model


def enhance_motion_blur(img):
    """
    Runs the vendored NAFNet (nafnet/) on a blurry crop. Session 9
    measured 0/3 -> 1/3 exact matches on the synthetic motion-blur
    benchmark, no regression on clean images, ~0.4-1.1s/image on CPU --
    real evidence, not a guess, but only tested against a synthetic
    15px box-kernel blur there; re-verified against real footage in
    Session 10 (see ALPR_IMPROVEMENT_LOG.md).

    Falls back to the original, un-enhanced crop if the model can't be
    loaded (Session 14) -- the caller doesn't need to know or care,
    since this always returns *something* usable for OCR.
    """
    model = _get_nafnet_model()
    if model is None:
        return img
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype("float32") / 255.0
    tensor = torch.from_numpy(img_rgb).permute(2, 0, 1).unsqueeze(0).to(device)
    with torch.no_grad():
        out = model(tensor)
    out = out.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy()
    return cv2.cvtColor((out * 255).astype("uint8"), cv2.COLOR_RGB2BGR)
