"""Tiny in-process TTL cache for expensive read-only computations (the
Map page's density/flow layers) -- a single Railway replica (see
database.py's pool sizing) makes a plain in-memory cache correct; a
multi-replica deployment would need a shared cache (Redis) instead, out of
scope at this project's scale.

The wrapped function's first positional argument is always a live DB
cursor -- deliberately excluded from the cache key (a fresh cursor object
from the pool never equals a previous one, which would make every call a
cache miss) and never itself cached."""
import time
from functools import wraps


def ttl_cache(seconds: float):
    def decorator(fn):
        store: dict[tuple, tuple[float, object]] = {}

        @wraps(fn)
        def wrapper(db, *args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            cached = store.get(key)
            if cached is not None and now < cached[0]:
                return cached[1]
            value = fn(db, *args, **kwargs)
            store[key] = (now + seconds, value)
            return value

        wrapper.cache_clear = store.clear
        return wrapper

    return decorator
