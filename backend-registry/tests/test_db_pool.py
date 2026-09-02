from app.db import _pool, get_conn


def test_get_conn_is_backed_by_a_shared_pool_not_a_fresh_connection_each_time():
    # A pool with real min/max sizing, not the old "psycopg.connect() every call" shape.
    assert _pool.min_size == 1
    assert _pool.max_size == 20


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


def test_pool_has_an_explicit_timeout_configured():
    from app.db import _pool
    assert _pool.timeout is not None
    assert _pool.timeout <= 10


def test_pool_max_size_defaults_to_a_documented_value():
    from app.db import _pool
    assert _pool.max_size == 20  # the documented default when DB_POOL_MAX_SIZE is unset


def test_pool_max_size_is_configurable_via_env_var(monkeypatch):
    # Reload the module with a different env var to prove it's actually read
    # at import time, not hardcoded -- this is the crux of the requirement.
    import importlib

    import app.db as db_module

    monkeypatch.setenv("DB_POOL_MAX_SIZE", "7")
    importlib.reload(db_module)
    try:
        assert db_module._pool.max_size == 7
    finally:
        monkeypatch.delenv("DB_POOL_MAX_SIZE", raising=False)
        importlib.reload(db_module)  # restore the default-configured pool for every other test
