from app.db import _pool, get_conn


def test_get_conn_is_backed_by_a_shared_pool_not_a_fresh_connection_each_time():
    # A pool with real min/max sizing, not the old "psycopg.connect() every call" shape.
    assert _pool.min_size == 1
    assert _pool.max_size == 10


def test_get_conn_still_returns_a_usable_connection():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            assert cur.fetchone()[0] == 1


def test_sequential_get_conn_calls_reuse_the_pool_rather_than_opening_unboundedly():
    # Ten sequential checkouts against a pool sized max_size=10 must all succeed --
    # each `with get_conn()` block returns its connection before the next one asks,
    # so this proves reuse (a per-request psycopg.connect() would also "pass" this,
    # which is exactly why test_get_conn_is_backed_by_a_shared_pool above is the one
    # that actually pins the pooling behavior; this one just confirms no regression
    # in ordinary sequential usage).
    for _ in range(10):
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                assert cur.fetchone()[0] == 1
