"""cleanup_expired_uploads: deletes an expired upload's on-disk bytes while
always keeping the anpr_jobs row itself (metadata, hash, linked results are
the evidentiary record -- never deleted, same as detections). Exercised
directly against the service function with a real temp file and a real
(backdated) row, rather than through the API -- there's no HTTP surface for
this, it only ever runs off the periodic loop or the manual script."""
import contextlib
import os
import tempfile

import psycopg2
import psycopg2.extras
from app.config import settings
from app.services import anpr_jobs_service


def _insert_job_with_file(stored_file_path: str, *, days_old: int) -> int:
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO anpr_jobs (input_type, status, submitted_by, district, stored_file_path, created_at)
            VALUES ('upload_image', 'completed', 'ANPR-CLEANUP-TEST', 'Anand', %s, now() - make_interval(days => %s))
            RETURNING id
            """,
            (stored_file_path, days_old),
        )
        job_id = cur.fetchone()["id"]
        conn.commit()
        return job_id


def _get_job(job_id: int) -> dict:
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM anpr_jobs WHERE id = %s", (job_id,))
        return cur.fetchone()


def _delete_job(job_id: int) -> None:
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM anpr_jobs WHERE id = %s", (job_id,))
        conn.commit()


def _run_cleanup(retention_days: int) -> int:
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        deleted = anpr_jobs_service.cleanup_expired_uploads(cur, retention_days)
        conn.commit()
        return deleted


def test_cleanup_deletes_the_file_but_keeps_the_job_row():
    fd, path = tempfile.mkstemp(prefix="anpr_cleanup_test_")
    os.close(fd)
    job_id = _insert_job_with_file(path, days_old=6)
    try:
        deleted = _run_cleanup(retention_days=5)
        assert deleted == 1
        assert not os.path.isfile(path)

        job = _get_job(job_id)
        assert job is not None  # the row itself is never removed
        assert job["stored_file_path"] == path  # metadata untouched, only the bytes are gone
    finally:
        _delete_job(job_id)
        if os.path.isfile(path):
            os.remove(path)


def test_cleanup_leaves_a_file_within_the_retention_window_alone():
    fd, path = tempfile.mkstemp(prefix="anpr_cleanup_test_")
    os.close(fd)
    job_id = _insert_job_with_file(path, days_old=2)
    try:
        deleted = _run_cleanup(retention_days=5)
        assert deleted == 0
        assert os.path.isfile(path)
    finally:
        _delete_job(job_id)
        if os.path.isfile(path):
            os.remove(path)


def test_cleanup_is_idempotent_when_the_file_is_already_gone():
    fd, path = tempfile.mkstemp(prefix="anpr_cleanup_test_")
    os.close(fd)
    os.remove(path)  # simulate an already-cleaned-up upload
    job_id = _insert_job_with_file(path, days_old=10)
    try:
        deleted = _run_cleanup(retention_days=5)
        assert deleted == 0  # nothing to delete, and no error

        job = _get_job(job_id)
        assert job is not None
    finally:
        _delete_job(job_id)
