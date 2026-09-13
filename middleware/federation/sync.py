import random
import time
import uuid
from datetime import datetime, timezone
import httpx
from psycopg.types.json import Jsonb
from .models import Source
from .adapters import read_page


def sync_page(store, source_id, transport=None):
    with store.lock(source_id) as db:
        if db is None: return 'busy'
        row = db.execute('SELECT * FROM fed_sources WHERE id=%s AND enabled AND next_due<=now()', (source_id,)).fetchone()
        if not row: return 'not_due'
        source = Source(**row['config'])
        run = row['run_id'] or uuid.uuid4()
        state = row['state'] or {'full': source.adapter != 'delta' or not row['checkpoint'] or not row['last_full'] or
                 (datetime.now(timezone.utc)-row['last_full']).total_seconds() >= source.full_reconcile_seconds,
                 'checkpoint': row['checkpoint'], 'etag': row['etag'], 'modified': row['modified'], 'pages': 0}
        start = time.monotonic()
        db.execute("UPDATE fed_sources SET status='syncing',last_attempt=now(),run_id=%s,state=%s WHERE id=%s", (run, Jsonb(state), source_id))
        try:
            with db.transaction():
                def emit(items):
                    with db.cursor() as cursor:
                        cursor.executemany('INSERT INTO fed_stage(run_id,id,payload) VALUES(%s,%s,%s)',
                                           [(run, item['id'], Jsonb(item)) for item in items])
                page = read_page(source, state, emit, transport)
                for ident in page.get('deleted', []):
                    db.execute('INSERT INTO fed_stage(run_id,id,deleted) VALUES(%s,%s,true)', (run, ident))
                duration = (time.monotonic()-start)*1000
                if page.get('next'):
                    state.update(page=page['next'], pages=state['pages']+1)
                    db.execute('UPDATE fed_sources SET state=%s,next_due=now(),queued_until=NULL,duration_ms=%s WHERE id=%s', (Jsonb(state), duration, source_id))
                    return 'next_page'
                changed = 0
                if not page.get('unchanged'):
                    changed += db.execute('''INSERT INTO fed_cameras(id,source_id,payload)
                      SELECT id,%s,payload FROM fed_stage WHERE run_id=%s AND NOT deleted
                      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,active=true,updated_at=now()
                      WHERE fed_cameras.payload IS DISTINCT FROM excluded.payload OR NOT fed_cameras.active''', (source_id, run)).rowcount
                    if state['full']:
                        changed += db.execute('''UPDATE fed_cameras c SET active=false,updated_at=now()
                          WHERE source_id=%s AND active AND NOT EXISTS
                          (SELECT 1 FROM fed_stage t WHERE t.run_id=%s AND t.id=c.id AND NOT t.deleted)''', (source_id, run)).rowcount
                    else:
                        changed += db.execute('''UPDATE fed_cameras c SET active=false,updated_at=now()
                          FROM fed_stage t WHERE t.run_id=%s AND t.deleted AND c.id=t.id AND c.active''', (run,)).rowcount
                db.execute('DELETE FROM fed_stage WHERE run_id=%s', (run,))
                interval = source.sync_interval_seconds if source.adapter == 'delta' else source.full_reconcile_seconds
                db.execute('''UPDATE fed_sources SET status='healthy',last_success=now(),duration_ms=%s,
                  changed=%s,camera_count=(SELECT count(*) FROM fed_cameras WHERE source_id=%s AND active),
                  failures=0,error_code=NULL,next_due=now()+make_interval(secs=>%s),queued_until=NULL,
                  checkpoint=coalesce(%s,checkpoint),etag=%s,modified=%s,
                  last_full=CASE WHEN %s THEN now() ELSE last_full END,run_id=NULL,state='{}' WHERE id=%s''',
                  (duration,changed,source_id,interval,page.get('checkpoint'),page.get('etag'),page.get('modified'),state['full'],source_id))
                return 'complete'
        except Exception as exc:
            code = ('http_' + str(exc.response.status_code) if isinstance(exc, httpx.HTTPStatusError) else
                    'timeout' if isinstance(exc, httpx.TimeoutException) else
                    'invalid_inventory' if isinstance(exc, (ValueError, KeyError, TypeError)) else 'sync_error')
            delay = min(900, 5*2**min(row['failures'], 8)) + random.uniform(0, 3)
            with db.transaction():
                db.execute('DELETE FROM fed_stage WHERE run_id=%s', (run,))
                db.execute('''UPDATE fed_sources SET status='retrying',failures=failures+1,total_failures=total_failures+1,
                  error_code=%s,duration_ms=%s,next_due=now()+make_interval(secs=>%s),queued_until=NULL,
                  run_id=NULL,state='{}' WHERE id=%s''', (code,(time.monotonic()-start)*1000,delay,source_id))
            return 'retrying'
