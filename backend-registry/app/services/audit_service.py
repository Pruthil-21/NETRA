"""Append-only audit log — insert/select only, never update or delete.

Hash-chained (Schneier & Kelsey, "Secure Audit Logs to Support Computer
Forensics", ACM TISSEC 1999): every row's entry_hash commits to its own
fields AND the previous chained row's entry_hash, so altering or deleting a
past row breaks every hash after it. This is the same shape AWS's own
current guidance recommends after retiring QLDB (hand-roll the chain
directly on Postgres) rather than a separate ledger database. See
audit_logs_service.verify_chain for the read side."""
import hashlib
import json

# Genesis value for the very first chained row (no predecessor to point at)
# -- an all-zero hash, the same convention Certificate Transparency logs use
# for an empty Merkle tree root.
GENESIS_HASH = "0" * 64

# Any fixed int64 works as the lock key -- it only needs to be the same
# constant every caller uses, so concurrent audit_service.log() calls (from
# different pooled connections/requests) serialize around computing
# prev_hash/entry_hash instead of two writers reading the same "last hash"
# and forking the chain. pg_advisory_xact_lock is transaction-scoped: it
# releases automatically on the commit() below, no separate unlock call.
_AUDIT_CHAIN_LOCK_KEY = 891273465


def _compute_entry_hash(prev_hash: str, row: dict) -> str:
    # sort_keys=True so the same logical row always serializes identically
    # regardless of dict insertion order -- required for verify_chain to be
    # able to recompute the exact same hash later.
    canonical = json.dumps(row, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(f"{prev_hash}:{canonical}".encode()).hexdigest()


def log(conn, user_id: str, action: str, resource_type: str, resource_id=None, badge_number=None, reason_code=None):
    # Almost every call site passes user.get("badge_number", user.get("sub"))
    # as user_id -- already a real badge number -- but leaves the separate
    # badge_number= kwarg unset, which is what audit_logs_service.list_logs's
    # actor-name enrichment join actually keys on. That silently left "who
    # did this" blank for most rows (camera/area/etc CRUD) while only
    # login/registration call sites (which happened to also pass badge_number=)
    # ever resolved a name. Defaulting it to user_id here fixes every call
    # site retroactively without touching each one -- a non-officer actor
    # ("ml-anpr", "system") just fails to join to a real officer and shows
    # as its own raw string, which is still strictly better than blank.
    if badge_number is None:
        badge_number = user_id
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (_AUDIT_CHAIN_LOCK_KEY,))
        # Skips rows with a NULL entry_hash (written before this chain
        # existed, or by a writer -- e.g. backend-watchlist's own audit
        # inserts into this same shared table -- that hasn't adopted it
        # yet) rather than treating a gap as the chain's start; those rows
        # simply aren't covered by the integrity guarantee, but they don't
        # break it for every row written after them either.
        cur.execute(
            "SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1"
        )
        prev = cur.fetchone()
        prev_hash = prev[0] if prev else GENESIS_HASH
        row_data = {
            "user_id": user_id, "action": action, "resource_type": resource_type,
            "resource_id": resource_id, "badge_number": badge_number, "reason_code": reason_code,
        }
        entry_hash = _compute_entry_hash(prev_hash, row_data)
        cur.execute("""
            INSERT INTO audit_logs
                (user_id, action, resource_type, resource_id, badge_number, reason_code, prev_hash, entry_hash)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (user_id, action, resource_type, resource_id, badge_number, reason_code, prev_hash, entry_hash))
        conn.commit()
