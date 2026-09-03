import os

from dotenv import load_dotenv
from psycopg_pool import ConnectionPool

load_dotenv()

# Pool size/timeout are environment-configurable, not hardcoded -- the
# right value depends on deployment topology this file can't know:
#
#   DB_POOL_MAX_SIZE (this service's connections) x number of
#   backend-registry replicas, PLUS backend-watchlist's own pool
#   (psycopg2 SimpleConnectionPool(1, 10, ...), one per its own replica
#   count) PLUS Postgres's reserved_connections (3 by default, for
#   superuser/admin use) PLUS headroom for direct psql/admin connections,
#   must all stay under Postgres's own max_connections (100 by default,
#   postgresql.conf). Default here (20) assumes a single backend-registry
#   replica and single backend-watchlist replica against a stock
#   max_connections=100 instance -- 20 + 10 + 3 + headroom comfortably
#   fits. A real multi-replica deployment sets DB_POOL_MAX_SIZE explicitly:
#   roughly (max_connections - reserved_connections - other_services) /
#   replica_count.
#
# This service is sync (every endpoint blocks its worker thread for the
# duration of its DB calls), and the scale-demo load test drives real
# concurrency at this pool -- the old 10-connection, no-explicit-timeout
# pool was a standing risk under any real concurrent load, not just this
# demo's.
_pool = ConnectionPool(
    conninfo=os.environ["DATABASE_URL"],
    min_size=int(os.environ.get("DB_POOL_MIN_SIZE", "1")),
    max_size=int(os.environ.get("DB_POOL_MAX_SIZE", "20")),
    timeout=int(os.environ.get("DB_POOL_TIMEOUT_SECONDS", "10")),
    open=True,
)


def get_conn():
    """Returns a context manager yielding a pooled connection -- every
    existing `with get_conn() as conn:` call site keeps working unchanged;
    only what happens *inside* get_conn() changed (checkout from a shared
    pool instead of a fresh psycopg.connect() per call)."""
    return _pool.connection()
