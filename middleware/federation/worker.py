import hashlib
import os
from celery import Celery
from celery.signals import worker_process_shutdown, worker_shutdown
from .store import Store
from .sync import sync_page

SHARDS = int(os.environ.get('FEDERATION_SHARDS', '8'))
broker = os.environ.get('FEDERATION_BROKER_URL', 'redis://localhost:6379/0')
celery = Celery('federation', broker=broker)
celery.conf.update(task_acks_late=True, task_reject_on_worker_lost=True, worker_prefetch_multiplier=1,
                   task_soft_time_limit=50, task_time_limit=60,
                   broker_transport_options={'visibility_timeout': 120},
                   beat_schedule={'dispatch': {'task': 'federation.dispatch', 'schedule': 2.0}})
_store = None
_pid = None


@worker_process_shutdown.connect
@worker_shutdown.connect
def close_pool(**kwargs):
    if _store is not None and _pid == os.getpid(): _store.pool.close()


def store():
    global _store, _pid
    if _pid != os.getpid():
        _store, _pid = Store(), os.getpid()
    return _store


@celery.task(name='federation.dispatch')
def dispatch():
    with store().pool.connection() as db, db.transaction():
        rows = db.execute('''SELECT id FROM fed_sources WHERE enabled AND next_due<=now()
          AND (queued_until IS NULL OR queued_until<now()) ORDER BY next_due LIMIT 100
          FOR UPDATE SKIP LOCKED''').fetchall()
        for row in rows:
            shard = int.from_bytes(hashlib.sha256(row['id'].encode()).digest()[:4], 'big') % SHARDS
            process.apply_async(args=[row['id']], queue=f'inventory.{shard}')
            db.execute("UPDATE fed_sources SET queued_until=now()+interval '120 seconds' WHERE id=%s", (row['id'],))
    return len(rows)


@celery.task(name='federation.process')
def process(source_id):
    return sync_page(store(), source_id)
