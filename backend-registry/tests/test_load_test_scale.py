# backend-registry/tests/test_load_test_scale.py
from scripts.load_test_scale import compute_stats


def test_compute_stats_basic_shape():
    result = compute_stats(latencies_ms=[10, 20, 30, 40, 50], error_count=0, duration_s=1.0)
    assert result["avg_ms"] == 30
    assert result["throughput_rps"] == 5.0
    assert result["error_rate"] == 0.0


def test_compute_stats_p95_of_100_requests():
    latencies = [float(i) for i in range(1, 101)]  # 1..100
    result = compute_stats(latencies_ms=latencies, error_count=0, duration_s=10.0)
    assert result["p95_ms"] == 95  # 95th percentile of 1..100 is 95

    assert result["throughput_rps"] == 10.0


def test_compute_stats_error_rate():
    result = compute_stats(latencies_ms=[10, 20], error_count=8, duration_s=1.0)
    # 2 successes + 8 errors = 10 total attempts, 8/10 = 0.8
    assert result["error_rate"] == 0.8


def test_compute_stats_handles_empty_latencies():
    result = compute_stats(latencies_ms=[], error_count=5, duration_s=1.0)
    assert result["avg_ms"] == 0
    assert result["p95_ms"] == 0
    assert result["error_rate"] == 1.0
