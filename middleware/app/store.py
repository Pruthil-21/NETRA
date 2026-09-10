import json
import sqlite3
from contextlib import contextmanager

from .models import utcnow


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY, status TEXT NOT NULL,
                    last_attempt TEXT, last_success TEXT, error TEXT);
                CREATE TABLE IF NOT EXISTS cameras (
                    id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
                    data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS events (
                    source_id TEXT NOT NULL, event_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL, plate TEXT NOT NULL,
                    detected_at TEXT NOT NULL, received_at TEXT NOT NULL,
                    confidence REAL NOT NULL, representative INTEGER NOT NULL,
                    PRIMARY KEY (source_id, event_id));
                CREATE INDEX IF NOT EXISTS events_plate_time ON events(plate, detected_at);
                CREATE INDEX IF NOT EXISTS events_time ON events(detected_at);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def sync(self, source_id, cameras=None, error=None):
        now = utcnow()
        with self.connect() as db:
            db.execute("""INSERT INTO sources VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status,
                last_attempt=excluded.last_attempt,
                last_success=COALESCE(excluded.last_success,sources.last_success), error=excluded.error""",
                (source_id, "unavailable" if error else "connected", now, None if error else now, error))
            if error is None:
                db.execute("UPDATE cameras SET active=0 WHERE source_id=?", (source_id,))
                db.executemany("""INSERT INTO cameras VALUES (?, ?, ?, 1)
                    ON CONFLICT(id) DO UPDATE SET data=excluded.data, active=1""",
                    [(c.id, source_id, c.model_dump_json()) for c in cameras])

    def begin_session(self, source_ids):
        # A previous process's successful sync does not prove current connectivity.
        with self.connect() as db:
            db.executemany("UPDATE sources SET status='initializing', error=NULL WHERE id=?",
                           [(source_id,) for source_id in source_ids])

    def record(self, source, event):
        with self.connect() as db:
            # Serialize check-and-insert across threads/processes, not only Python callers.
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT * FROM events WHERE source_id=? AND event_id=?", (source.id, event.event_id)).fetchone()
            values = (event.camera_id, event.plate, event.detected_at.isoformat(), event.confidence)
            if previous:
                if tuple(previous[k] for k in ("camera_id", "plate", "detected_at", "confidence")) != values:
                    raise ValueError("Event ID already used for a different detection")
                return dict(previous), True
            camera = db.execute("SELECT 1 FROM cameras WHERE id=? AND source_id=? AND active=1", (event.camera_id, source.id)).fetchone()
            if not camera:
                raise LookupError("Camera is not active in this source inventory")
            db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (source.id, event.event_id, *values[:3], utcnow(), values[3], source.representative))
            return dict(db.execute("SELECT * FROM events WHERE source_id=? AND event_id=?", (source.id, event.event_id)).fetchone()), False

    def sources(self):
        with self.connect() as db:
            return {r["id"]: dict(r) for r in db.execute("SELECT * FROM sources")}

    def cameras(self, source_ids, limit, offset, source_id=None):
        ids = [source_id] if source_id in source_ids else list(source_ids) if source_id is None else []
        with self.connect() as db:
            rows = db.execute(f"SELECT * FROM cameras WHERE active=1 AND source_id IN ({','.join('?' for _ in ids)}) ORDER BY id LIMIT ? OFFSET ?", (*ids, limit, offset)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def events(self, source_ids, limit, offset, plate=None, after=None, before=None):
        clauses = [f"e.source_id IN ({','.join('?' for _ in source_ids)})"]
        args = list(source_ids)
        for clause, value in (("e.plate=?", plate), ("e.detected_at>=?", after), ("e.detected_at<=?", before)):
            if value is not None:
                clauses.append(clause)
                args.append(value)
        with self.connect() as db:
            rows = db.execute("SELECT e.*, c.data AS camera FROM events e LEFT JOIN cameras c ON c.id=e.camera_id WHERE " +
                " AND ".join(clauses) + " ORDER BY e.detected_at, e.source_id, e.event_id LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        return [{**{k: r[k] for k in r.keys() if k != "camera"}, "camera": json.loads(r["camera"]) if r["camera"] else None} for r in rows]
