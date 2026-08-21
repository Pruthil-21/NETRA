"""PostgreSQL connection pool and a request-scoped cursor dependency.

Uses the same Postgres instance as backend-registry (separate tables,
shared instance) — matches the DB connection convention P1 is using,
so both services read DATABASE_URL from the same docker-compose service.
"""
from contextlib import contextmanager

from psycopg2 import pool
from psycopg2.extras import RealDictCursor

from .config import settings

_pool = pool.SimpleConnectionPool(1, 10, dsn=settings.database_url)


@contextmanager
def get_connection():
    conn = _pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def get_db():
    """FastAPI dependency yielding a RealDictCursor scoped to one request."""
    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            yield cursor