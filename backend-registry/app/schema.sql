"""One shared, minimal logger for real application events (camera status
transitions, etc.) -- deliberately not uvicorn's own access log, which is
disabled separately in the Dockerfile CMD. Only the events this codebase
explicitly logs (see Tasks 3 and 6 of the backend-logging-and-camera-uptime
plan) ever reach this logger -- no per-request noise.
"""
import logging


def configure_logging() -> logging.Logger:
    log = logging.getLogger("netra")
    log.setLevel(logging.INFO)
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        log.addHandler(handler)
    return log


logger = configure_logging()
