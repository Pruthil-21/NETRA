"""One shared, minimal logger for real application events (alert created,
watchlist entry added, alert status changed -- see the "log the events that
actually matter" task). Deliberately not uvicorn's own access log, which is
disabled separately in the Dockerfile CMD.
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
