"""Tiny in-process TTL cache for expensive read-only computations (gap
analysis) -- a single Railway replica (see db.py's pool-sizing comment)
makes a plain in-memory cache correct; a multi-replica deployment would
need a shared cache (Redis) instead, out of scope at this project's scale.

The wrapped function's first positional argument is always a live DB
connection -- deliberately excluded from the cache key (a fresh connection
object from the pool never equals a previous one, which would make every
call a cache miss) and never itself cached."""
import time
from functools import wraps


def ttl_cache(seconds: float):
    def decorator(fn):
        store: dict[tuple, tuple[float, object]] = {}

        @wraps(fn)
        def wrapper(conn, *args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            cached = store.get(key)
            if cached is not None and now < cached[0]:
                return cached[1]
            value = fn(conn, *args, **kwargs)
            store[key] = (now + seconds, value)
            return value

        wrapper.cache_clear = store.clear
        return wrapper

    return decorator
