"""Seeds the districts/talukas/villages reference hierarchy from
app/data/gujarat_locations.json (built by scripts/build_data/
fetch_gujarat_locations.py -- see that file's docstring for data
provenance). Idempotent -- safe to run against an already-seeded database,
upserts by lgd_code where one exists, else by (parent, name).

Run once, after applying schema.sql's districts/talukas/villages tables:
    docker compose exec backend-registry python scripts/seed_locations.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "data", "gujarat_locations.json")


def seed():
    with open(DATA_PATH, encoding="utf-8") as f:
        payload = json.load(f)

    districts = payload["districts"]
    print(f"Loaded {payload['counts']} from {payload['source']} (dataset dated {payload['dataset_dated']})")

    with get_conn() as conn:
        with conn.cursor() as cur:
            for d in districts:
                cur.execute(
                    """
                    INSERT INTO districts (name, lgd_code) VALUES (%(name)s, %(lgd_code)s)
                    ON CONFLICT (name) DO UPDATE SET lgd_code = EXCLUDED.lgd_code
                    RETURNING id
                    """,
                    d,
                )
                district_id = cur.fetchone()[0]

                for t in d["talukas"]:
                    cur.execute(
                        """
                        INSERT INTO talukas (name, district_id, lgd_code, no_lgd_data)
                        VALUES (%(name)s, %(district_id)s, %(lgd_code)s, %(no_lgd_data)s)
                        ON CONFLICT (district_id, name) DO UPDATE SET
                            lgd_code = EXCLUDED.lgd_code, no_lgd_data = EXCLUDED.no_lgd_data
                        RETURNING id
                        """,
                        {
                            "name": t["name"],
                            "district_id": district_id,
                            "lgd_code": t["lgd_code"],
                            "no_lgd_data": t.get("no_lgd_data", False),
                        },
                    )
                    taluka_id = cur.fetchone()[0]

                    if t["villages"]:
                        cur.executemany(
                            """
                            INSERT INTO villages (name, taluka_id, lgd_code, is_urban)
                            VALUES (%(name)s, %(taluka_id)s, %(lgd_code)s, %(is_urban)s)
                            ON CONFLICT (taluka_id, name) DO UPDATE SET
                                lgd_code = EXCLUDED.lgd_code, is_urban = EXCLUDED.is_urban
                            """,
                            [
                                {
                                    "name": v["name"],
                                    "taluka_id": taluka_id,
                                    "lgd_code": v["lgd_code"],
                                    "is_urban": v["is_urban"],
                                }
                                for v in t["villages"]
                            ],
                        )
        conn.commit()

    print(f"Seeded {payload['counts']['districts']} districts, "
          f"{payload['counts']['talukas']} talukas, {payload['counts']['villages']} villages.")


if __name__ == "__main__":
    seed()
