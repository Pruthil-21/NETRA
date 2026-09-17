"""Gap-analysis report computations: uncovered zones (coverage targets
farther than a threshold from the nearest camera), ageing infrastructure
(old cameras with a history of connectivity problems), and new-camera
placement suggestions (which uncovered zones to close first)."""

# priority is free-text on coverage_targets ('high'/'medium'/'low', see
# schema.sql) -- this is the actual, real-world criterion an MHA Safe City
# advisory names for CCTV siting (crime hotspots and critical infrastructure
# get priority over an arbitrary distance circle): a target an admin marked
# 'high' should out-rank a 'medium'/'low' one in both the plain gap report's
# ordering and the placement-suggestion algorithm's scoring below. Anything
# outside this map (a typo, a future value) safely falls back to medium
# weight rather than KeyError-ing the whole report.
_PRIORITY_WEIGHT = {"high": 3, "medium": 2, "low": 1}


def _priority_weight(priority: str | None) -> int:
    return _PRIORITY_WEIGHT.get((priority or "medium").lower(), 2)


def compute_uncovered_zones(conn, threshold_m: int = 100) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                t.id, t.name, t.district, t.priority,
                nearest.camera_id, nearest.distance_meters
            FROM coverage_targets t
            LEFT JOIN LATERAL (
                SELECT c.id AS camera_id, ST_Distance(t.location, c.location) AS distance_meters
                FROM cameras c
                WHERE c.is_synthetic = false AND c.is_virtual_capture = false
                ORDER BY t.location <-> c.location
                LIMIT 1
            ) nearest ON true
            ORDER BY t.id
            """
        )
        rows = cur.fetchall()

    zones = []
    for target_id, name, district, priority, camera_id, distance_meters in rows:
        if camera_id is None or distance_meters > threshold_m:
            zones.append({
                "target_id": target_id,
                "name": name,
                "district": district,
                "priority": priority,
                "nearest_camera_id": camera_id,
                "distance_meters": distance_meters,
                "_priority_weight": _priority_weight(priority),
            })
    # Highest-priority gaps (crime hotspots / critical infrastructure, per
    # the coverage_target's own priority field) surface first, not
    # whatever order the table happens to return them in -- a commander
    # scanning the top of this list should see the gaps that matter most,
    # not the numerically-lowest target id.
    zones.sort(key=lambda z: (-z["_priority_weight"], z["distance_meters"] is None, z["distance_meters"] or 0))
    for z in zones:
        del z["_priority_weight"]
    return zones


def compute_ageing_infrastructure(conn, age_threshold_days: int = 1095) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                c.id, c.name, c.dept,
                EXTRACT(DAY FROM now() - c.created_at)::int AS age_days,
                COUNT(h.id) FILTER (
                    WHERE h.connectivity_status IN ('offline', 'degraded')
                    AND h.changed_at > now() - interval '90 days'
                ) AS degraded_transition_count_90d
            FROM cameras c
            LEFT JOIN camera_status_history h ON h.camera_id = c.id
            WHERE c.created_at < now() - (%s || ' days')::interval
            AND c.is_synthetic = false AND c.is_virtual_capture = false
            GROUP BY c.id, c.name, c.dept, c.created_at
            ORDER BY degraded_transition_count_90d DESC, age_days DESC
            """,
            (age_threshold_days,),
        )
        rows = cur.fetchall()

    # Honest, explainable risk label -- deliberately NOT statistical survival
    # analysis (Weibull/Kaplan-Meier, the kind GE Predix/Siemens MindSphere
    # run): those need real failure-event or continuous-telemetry history,
    # which this registry doesn't have, only AMC-style age + connectivity
    # history. A commander needs "this one's overdue and flaky, look at it
    # first," not a manufactured confidence interval this data can't back up.
    def _risk_level(age_days: int, degraded_count: int) -> str:
        if degraded_count >= 3:
            return "high"
        if degraded_count >= 1 or age_days >= age_threshold_days * 1.5:
            return "medium"
        return "low"

    return [
        {
            "camera_id": camera_id,
            "name": name,
            "district": district,
            "age_days": age_days,
            "degraded_transition_count_90d": degraded_count,
            "risk_level": _risk_level(age_days, degraded_count),
        }
        for camera_id, name, district, age_days, degraded_count in rows
    ]


def suggest_camera_placements(
    conn, threshold_m: int = 100, budget: int = 5
) -> list[dict]:
    """Greedy set-cover: repeatedly pick the uncovered coverage_target whose
    own location would cover the most weighted "demand" (itself plus every
    other still-uncovered target within threshold_m of it), until `budget`
    new cameras have been suggested or no uncovered target remains.

    Deliberately greedy, not an exact ILP/max-k-coverage solve. Greedy
    set-cover is provably within a factor of (1 + ln n) of the true optimum
    (classic result), runs in milliseconds regardless of coverage_targets
    count, and -- the reason that matters more for this use case -- every
    pick is explainable in one sentence ("this site covers the most
    still-uncovered priority points right now"), which an ILP solver's
    black-box optimum isn't. Research into the alternative (a real 2024
    max-k-coverage ILP paper) found it only stays tractable up to a few
    hundred candidate sites per solve and can't be sanity-checked by eye --
    the wrong tradeoff for something a non-technical commander has to trust.
    """
    uncovered = compute_uncovered_zones(conn, threshold_m)
    if not uncovered:
        return []

    target_ids = [z["target_id"] for z in uncovered]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, district, priority,
                   ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS long
            FROM coverage_targets
            WHERE id = ANY(%s)
            """,
            (target_ids,),
        )
        cols = [c.name for c in cur.description]
        targets = {row[0]: dict(zip(cols, row)) for row in cur.fetchall()}

        # "Does a camera at candidate site A also cover demand point B"
        # within threshold_m -- computed once as a self-join over the
        # (small, admin-curated) uncovered set, not per-iteration and not
        # via N Python-side haversine calls.
        cur.execute(
            """
            SELECT a.id AS site_id, b.id AS covers_id
            FROM coverage_targets a
            JOIN coverage_targets b
              ON a.id = ANY(%(ids)s) AND b.id = ANY(%(ids)s)
              AND ST_DWithin(a.location, b.location, %(threshold)s)
            """,
            {"ids": target_ids, "threshold": threshold_m},
        )
        coverage_pairs = cur.fetchall()

    covers: dict[int, set[int]] = {tid: set() for tid in target_ids}
    for site_id, covers_id in coverage_pairs:
        covers[site_id].add(covers_id)

    weight = {tid: _priority_weight(targets[tid]["priority"]) for tid in target_ids}
    remaining = set(target_ids)
    suggestions: list[dict] = []

    while remaining and len(suggestions) < budget:
        best_site, best_covered, best_score = None, set(), -1.0
        for site_id in target_ids:
            covered_now = covers[site_id] & remaining
            if not covered_now:
                continue
            score = sum(weight[c] for c in covered_now)
            if score > best_score:
                best_site, best_covered, best_score = site_id, covered_now, score
        if best_site is None:  # nothing left covers any remaining point
            break
        site = targets[best_site]
        suggestions.append({
            "suggested_at_target_id": best_site,
            "suggested_at_name": site["name"],
            "district": site["district"],
            "lat": site["lat"],
            "long": site["long"],
            "covers_target_ids": sorted(best_covered),
            "priority_weighted_score": float(best_score),
        })
        remaining -= best_covered

    return suggestions
