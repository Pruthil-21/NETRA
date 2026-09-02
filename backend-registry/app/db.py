import os

from dotenv import load_dotenv
from psycopg_pool import ConnectionPool

load_dotenv()

# Opened once at import instead of connecting fresh per request — matches
# backend-watchlist's psycopg2.pool.SimpleConnectionPool(1, 10, ...) convention.
pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=10, open=True)


def get_conn():
    return pool.connection()
