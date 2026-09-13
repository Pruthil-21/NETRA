"""Read-only lookups over the districts/talukas/villages reference
hierarchy -- raw SQL via psycopg, no ORM. Nothing here ever writes: the
hierarchy is government reference data seeded once by scripts/seed_locations.py,
never created/edited/deleted through the app (see schema.sql's districts
table comment)."""


def list_districts(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, lgd_code FROM districts ORDER BY name")
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def district_exists(conn, name: str) -> bool:
    """Exact, case-sensitive match against the canonical district list --
    used to validate a district name typed or picked elsewhere (e.g.
    self-registration's Department/District field) against the same
    reference set the app's own dropdowns are populated from, rather than
    accepting any non-empty string."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM districts WHERE name = %s", (name,))
        return cur.fetchone() is not None


def list_talukas(conn, district_id: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, district_id, no_lgd_data FROM talukas WHERE district_id = %s ORDER BY name",
            (district_id,),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# Capped so a blank/very short search on a huge taluka never pulls its whole
# village list into one response -- the picker always has a taluka selected
# first (or a search term), so this rarely gets exercised in practice at
# Gujarat's actual scale.
_VILLAGE_PAGE_SIZE = 50


def search_villages(conn, taluka_id: int | None = None, search: str | None = None, limit: int = _VILLAGE_PAGE_SIZE) -> list[dict]:
    """Villages, optionally scoped to one taluka and/or filtered by a
    substring search over the name -- backs the type-to-search picker at
    19,000+ rows. `search` uses ILIKE '%term%' against the pg_trgm-indexed
    name column (schema.sql's idx_villages_name_trgm), not a prefix match,
    since officers search by whatever part of the name they remember."""
    limit = min(limit, 200)
    clauses = []
    params: dict = {"limit": limit}
    if taluka_id is not None:
        clauses.append("taluka_id = %(taluka_id)s")
        params["taluka_id"] = taluka_id
    if search:
        clauses.append("name ILIKE %(search)s")
        params["search"] = f"%{search}%"
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, name, taluka_id, is_urban FROM villages {where} ORDER BY name LIMIT %(limit)s",
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_village_path(conn, village_id: int) -> dict | None:
    """The (district, taluka, village) name triple for one village -- used
    to denormalize AreaOut so the frontend never has to do 3 lookups to show
    where an area actually is."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT d.name AS district, t.name AS taluka, v.name AS village
            FROM villages v
            JOIN talukas t ON t.id = v.taluka_id
            JOIN districts d ON d.id = t.district_id
            WHERE v.id = %s
            """,
            (village_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))
