"""Partitioned feed-loss detector and transactional retrying notification outbox."""
import concurrent.futures
from datetime import datetime, timezone
import logging
import json
import os
from pathlib import Path
import random
import time
import uuid
import httpx
from psycopg.types.json import Jsonb
from common import database, audit
from core import retry_delay


def sweep(pool, bucket):
    cursor = ''
    threshold = int(os.environ.get('ALERT_AFTER_SECONDS', '120'))
    while True:
        with pool.connection() as conn:
            rows = conn.execute('''SELECT *, CASE
              WHEN status='disk_full' THEN 'disk_full'
              WHEN checked_at < now()-make_interval(secs => %s) THEN 'worker_unavailable'
              WHEN COALESCE(last_frame_at,assigned_at) < now()-make_interval(secs => %s) THEN 'feed_lost'
              WHEN COALESCE(last_segment_at,assigned_at) < now()-make_interval(secs => %s) THEN 'archive_delayed'
              ELSE 'healthy' END AS effective FROM camera_health
              WHERE bucket=%s AND path>%s ORDER BY path LIMIT 500''',
              (threshold, threshold, threshold+120, bucket, cursor)).fetchall()
            if rows:
                changed = conn.execute("""INSERT INTO health_states(path,state)
                  SELECT * FROM unnest(%s::text[],%s::text[])
                  ON CONFLICT(path) DO UPDATE SET state=excluded.state
                  WHERE health_states.state<>excluded.state RETURNING path""",
                  ([r['path'] for r in rows], [r['effective'] for r in rows])).fetchall()
                paths = {r['path'] for r in changed}
                events = []
                audits = []
                for row in rows:
                    if row['path'] not in paths:
                        continue
                    payload = {'event': 'recording.health', 'path': row['path'], 'shard': row['shard'],
                               'state': row['effective'], 'at': datetime.now(timezone.utc).isoformat()}
                    events.append((row['path'], row['effective'], uuid.uuid4(), Jsonb(payload)))
                    audits.append((row['path'], uuid.uuid4(), 'health-monitor', 'health.transition', Jsonb(payload)))
                with conn.cursor() as cur:
                    cur.executemany('INSERT INTO notifications(path,state,event_id,payload) VALUES(%s,%s,%s,%s)', events)
                    cur.executemany('INSERT INTO audit(path,id,actor,action,details) VALUES(%s,%s,%s,%s,%s)', audits)
        if len(rows) < 500:
            return
        cursor = rows[-1]['path']


def deliver(pool):
    with pool.connection() as conn:
        row = conn.execute('''SELECT * FROM notifications WHERE delivered_at IS NULL AND due_at<=now()
            ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1''').fetchone()
        if not row:
            return False
        try:
            event_id = str(row['event_id'])
            aliases = json.loads(os.environ.get('WEBHOOK_PATH_ALIASES', '{}'))
            body = {'event_id': event_id, 'path': aliases.get(row['path'], row['path']), 'status': row['state'],
                    'payload': row['payload']}
            if row['payload'].get('at'):
                body['occurred_at'] = row['payload']['at']
            response = httpx.post(os.environ['NOTIFICATION_WEBHOOK'], json=body,
                headers={'X-Webhook-Key': os.environ['NOTIFICATION_WEBHOOK_KEY'],
                'Idempotency-Key': str(row['event_id'])}, timeout=5, follow_redirects=False)
            response.raise_for_status()
            acknowledgment = response.json()
            if (response.status_code != 202 or acknowledgment.get('event_id') != event_id
                    or acknowledgment.get('status') != 'accepted'):
                raise ValueError('Webhook did not acknowledge this event')
            conn.execute('UPDATE notifications SET delivered_at=now() WHERE event_id=%s', (row['event_id'],))
        except Exception:
            conn.execute('UPDATE notifications SET attempts=attempts+1,due_at=now()+make_interval(secs=>%s) WHERE event_id=%s',
                         (retry_delay(row['attempts'], random.random()), row['event_id']))
        return True


def main():
    logging.basicConfig(level=logging.INFO)
    pool = database()
    # All replicas may detect: partition advisory locks prevent duplicate concurrent sweeps.
    def detect():
        while True:
            for bucket in range(64):
                with pool.connection() as conn:
                    if conn.execute('SELECT pg_try_advisory_xact_lock(72391,%s)', (bucket,)).fetchone()['pg_try_advisory_xact_lock']:
                        sweep(pool, bucket)
                Path('/tmp/monitor.alive').write_text(str(time.time()))
            time.sleep(30)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(detect)
        while not future.done():
            if os.environ.get('NOTIFICATION_DELIVERY_ENABLED', 'true').lower() != 'true' or not deliver(pool):
                time.sleep(1)
        future.result()  # crash on detector failure; Kubernetes replaces the pod

if __name__ == '__main__':
    main()
