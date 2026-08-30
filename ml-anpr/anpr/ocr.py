"""OCR adapter -- routes through the isolated PaddleOCR worker process(es)
configured in .config (GPU primary, CPU fallback)."""
from .config import _gpu_ocr_client, _cpu_ocr_client


def _ocr_readtext(img):
    """
    Adapter matching EasyOCR's readtext() return shape
    (list of (bbox, text, confidence)) so the candidate-filtering logic
    in detection.py didn't need to change when the OCR engine did.
    PaddleOCR needs a 3-channel image -- unlike EasyOCR it crashes on
    grayscale input, and testing showed it doesn't need extra
    preprocessing anyway (it has its own internal doc/text
    preprocessing): the raw BGR crop alone scored 0.999-1.000 on every
    ground-truth image tested.
    """
    if _gpu_ocr_client is not None:
        try:
            pairs = _gpu_ocr_client.read(img)
            return [(None, text, conf) for text, conf in pairs]
        except Exception as e:
            print(f"[WARN] GPU OCR worker unavailable ({e}), falling back to CPU worker for this process")

    pairs = _cpu_ocr_client.read(img)
    return [(None, text, conf) for text, conf in pairs]
