"""Multi-posting jurisdiction resolution -- ported from backend-registry's
own rbac_scope.py (same JWT shape, same shared secret; duplicated rather
than imported cross-folder, same convention auth.py's docstring already
states for this service). Only effective_district_scopes is needed here:
backend-watchlist has no postings/roles tables of its own, so the
resolve_district_scoped/guard_delegated_posting_assignment helpers that
depend on them stay backend-registry-only."""


def effective_district_scopes(user: dict) -> list[str] | None:
    """Multi-role jurisdiction: "effective jurisdiction is the union of
    every active posting's scope." Returns None for platform-wide (no
    filter -- sees/acts on everything), an empty list for "holds no
    district jurisdiction at all", or the deduplicated list of every
    district this officer is actively posted to.

    Falls back to the token's single legacy scope_type/scope_value pair
    when no `scopes` claim is present at all -- every hand-crafted
    test/demo token, and any token issued before multi-posting existed."""
    scopes = user.get("scopes")
    if scopes is None:
        if user.get("scope_type") == "district":
            return [user.get("scope_value")]
        # Platform, or a legacy hand-crafted token with no scope_type claim
        # at all -- both are unrestricted, matching this codebase's
        # original single-scope behavior before multi-posting existed.
        return None
    if not scopes:
        return []
    if any(s.get("scope_type") == "platform" for s in scopes):
        return None
    return sorted({s["scope_value"] for s in scopes if s.get("scope_type") == "district" and s.get("scope_value")})
