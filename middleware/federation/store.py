import os
from pathlib import Path
from contextlib import contextmanager
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool


class Store:
    def __init__(self, dsn=None):
        self.pool = ConnectionPool(dsn or os.environ['FEDERATION_DATABASE_URL'], min_size=1, max_size=8, open=True,
                                   kwargs={'row_factory': dict_row, 'autocommit': True}, timeout=5)
        self.pool.wait(10)

    def migrate(self):
        with self.pool.connection() as db, db.transaction():
            db.execute('SELECT pg_advisory_xact_lock(913402)')
            db.execute(Path(__file__).with_name('schema.sql').read_text())

    def configure(self, sources):
        with self.pool.connection() as db, db.transaction():
            db.execute('UPDATE fed_sources SET enabled=false')
            for source in sources:
                db.execute('INSERT INTO fed_sources(id,config) VALUES(%s,%s) ON CONFLICT(id) DO UPDATE SET config=excluded.config,enabled=true', (source.id, Jsonb(source.model_dump())))

    def upsert_source(self, source):
        """Adds or edits a single source at runtime -- unlike configure()
        above (the one-shot bootstrap script), this never touches any other
        source's enabled state. A brand-new id starts enabled with a fresh
        sync schedule; editing an existing id keeps its sync history
        (status/counters/checkpoint) and just swaps the config, re-enabling
        it if it had been deleted (disabled) before."""
        with self.pool.connection() as db, db.transaction():
            db.execute('''INSERT INTO fed_sources(id,config) VALUES(%s,%s)
              ON CONFLICT(id) DO UPDATE SET config=excluded.config,enabled=true''', (source.id, Jsonb(source.model_dump())))

    def disable_source(self, source_id):
        """"Deleting" a source only ever disables it (never a hard DELETE):
        fed_cameras/fed_mappings rows keep their history, and re-adding the
        same id later (upsert_source) picks the sync schedule back up
        instead of starting cold. Matches how a source silently disappears
        today when it's dropped from sources.local.json and re-configured.
        Returns False if the id never existed."""
        with self.pool.connection() as db:
            return db.execute('UPDATE fed_sources SET enabled=false WHERE id=%s RETURNING id', (source_id,)).fetchone() is not None

    @contextmanager
    def lock(self, source_id):
        with self.pool.connection() as db:
            locked = db.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,0)) AS ok', (source_id,)).fetchone()['ok']
            try: yield db if locked else None
            finally:
                if locked: db.execute('SELECT pg_advisory_unlock(hashtextextended(%s,0))', (source_id,))

    def cameras(self, after='', limit=100, source_id=None):
        with self.pool.connection() as db:
            rows = db.execute('''SELECT c.id,c.payload,m.registry_camera_id,
              s.last_success IS NULL OR s.last_success < now() - make_interval(secs =>
              2 * CASE WHEN s.config->>'adapter'='delta' THEN (s.config->>'sync_interval_seconds')::int
              ELSE (s.config->>'full_reconcile_seconds')::int END) AS stale
              FROM fed_cameras c JOIN fed_sources s ON s.id=c.source_id
              LEFT JOIN fed_mappings m ON m.camera_id=c.id
              WHERE c.active AND s.enabled AND c.id>%s AND (%s::text IS NULL OR c.source_id=%s)
              ORDER BY c.id LIMIT %s''', (after, source_id, source_id, limit + 1)).fetchall()
        return {'items': [dict(r['payload'], registry_camera_id=r['registry_camera_id'], stale=r['stale']) for r in rows[:limit]],
                'next_cursor': rows[limit-1]['id'] if len(rows)>limit else None}

    def sources(self):
        with self.pool.connection() as db:
            return db.execute('''SELECT id,status,next_due,queued_until,last_attempt,last_success,last_full,
              duration_ms,changed,camera_count,failures,total_failures,error_code,
              next_due < now()-interval '2 minutes' AS overdue
              FROM fed_sources WHERE enabled ORDER BY id''').fetchall()

    def source_config(self, source_id):
        """The full config JSONB for one enabled source -- unlike sources()
        above, this is what an edit form pre-fills from. Safe to expose:
        credential-shaped fields (headers_env, login_email_env,
        login_password_env) are only ever env-VAR-NAME references, never
        the actual secret values, which live solely in the process
        environment."""
        with self.pool.connection() as db:
            row = db.execute('SELECT config FROM fed_sources WHERE id=%s AND enabled', (source_id,)).fetchone()
        return row['config'] if row else None

    def mapping(self, camera_id, registry_id, actor):
        with self.pool.connection() as db, db.transaction():
            if not db.execute('SELECT id FROM fed_cameras WHERE id=%s AND active', (camera_id,)).fetchone():
                raise ValueError('Unknown active camera')
            db.execute('''INSERT INTO fed_mappings(camera_id,registry_camera_id,actor) VALUES(%s,%s,%s)
              ON CONFLICT(camera_id) DO UPDATE SET registry_camera_id=excluded.registry_camera_id,
              actor=excluded.actor,updated_at=now()''', (camera_id, registry_id, actor))
            db.execute('INSERT INTO fed_mapping_audit(camera_id,registry_camera_id,actor) VALUES(%s,%s,%s)', (camera_id, registry_id, actor))
