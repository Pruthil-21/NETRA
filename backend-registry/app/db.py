import os

from dotenv import load_dotenv
from psycopg_pool import ConnectionPool

load_dotenv()

# Sized to match backend-watchlist's own pool (app/database.py's
# SimpleConnectionPool(1, 10, ...)) -- same Postgres instance, same rough
# per-service concurrency budget. Opened at import time (psycopg_pool's
# default): the first request after container startup pays a one-time
# warmup, not a per-request one.
_pool = ConnectionPool(conninfo=os.environ["DATABASE_URL"], min_size=1, max_size=10)


def get_conn():
    """Returns a context manager yielding a pooled connection -- every
    existing `with get_conn() as conn:` call site keeps working unchanged;
    only what happens *inside* get_conn() changed (checkout from a shared
    pool instead of a fresh psycopg.connect() per call)."""
    return _pool.connection()
