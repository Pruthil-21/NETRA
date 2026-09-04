from app.db import get_conn


def test_circles_table_and_camera_column_exist():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'circles' ORDER BY column_name"
        )
        circle_columns = {row[0] for row in cur.fetchall()}
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'cameras' AND column_name = 'circle_id'"
        )
        camera_has_circle_id = cur.fetchone() is not None

    assert circle_columns == {"id", "name", "district", "created_at"}
    assert camera_has_circle_id
