def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "database": "reachable"}


def test_health_reports_degraded_when_database_is_unreachable(client, monkeypatch):
    """A load balancer/orchestrator must never see a static 200 -- an
    unreachable database means every real endpoint here would 500, so
    /health has to say so with a 503 rather than reporting healthy."""
    from app import main

    def _broken_get_conn():
        raise ConnectionError("database unreachable")

    monkeypatch.setattr(main, "get_conn", _broken_get_conn)
    resp = client.get("/health")
    assert resp.status_code == 503
    assert resp.json() == {"status": "degraded", "database": "unreachable"}
