"""Private registry-facing archive API. Deploy behind existing login/RBAC."""
import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from common import audit, database, storage
from core import coverage, digest, stream_path, utc

pool = None
s3 = None

@asynccontextmanager
async def lifespan(app):
    global pool, s3
    for key in ('RECORDING_SERVICE_KEY', 'PLAYBACK_SIGNING_KEY'):
        if len(os.environ.get(key, '')) < 32:
            raise RuntimeError(key + ' must have at least 32 characters')
    pool, s3 = database(), storage()
    yield
    pool.close()

app = FastAPI(title='DIGDHRISHTI Recording Archive', lifespan=lifespan)
# Synchronous FastAPI endpoints run in a bounded thread pool; heavy work has its own gate.
import threading
exports = threading.BoundedSemaphore(int(os.environ.get('EXPORT_CONCURRENCY', '2')))


def authorize(request, path, start=None, end=None):
    service_key = request.headers.get('X-Service-Key', '')
    if service_key and hmac.compare_digest(service_key, os.environ['RECORDING_SERVICE_KEY']):
        actor = request.headers.get('X-Actor-ID', '')
        if not actor or len(actor) > 256:
            raise HTTPException(400, 'Verified actor ID required from registry proxy')
        return actor
    try:
        raw, signature = request.query_params.get('token', '').split('.')
        expected = hmac.new(os.environ['PLAYBACK_SIGNING_KEY'].encode(), raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        claim = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
        if claim['exp'] < time.time() or claim['path'] != path or start is None or end is None:
            raise ValueError()
        if start < utc(claim['start']) or end > utc(claim['end']):
            raise ValueError()
        return claim['actor']
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, 'Registry authorization or scoped playback token required')


def token(path, start, end, actor):
    raw = base64.urlsafe_b64encode(json.dumps({'path': path, 'start': start.isoformat(),
        'end': end.isoformat(), 'actor': actor, 'exp': time.time()+900}).encode()).decode().rstrip('=')
    return raw + '.' + hmac.new(os.environ['PLAYBACK_SIGNING_KEY'].encode(), raw.encode(), hashlib.sha256).hexdigest()


def canonical_path(path):
    # Explicit registry aliases only; never strip prefixes or guess a camera identity.
    aliases = json.loads(os.environ.get('RECORDING_PATH_ALIASES', '{}'))
    return stream_path(aliases.get(path, path))


def validate(path, start=None, end=None):
    try:
        canonical_path(path)
        first = utc(start) if start else datetime.now(timezone.utc)-timedelta(days=1)
        last = utc(end) if end else datetime.now(timezone.utc)
        if last <= first or (last-first).total_seconds() > 31*86400:
            raise ValueError()
        return first, last
    except ValueError:
        raise HTTPException(400, 'Invalid stream path or timezone-aware range (maximum 31 days)')


def query(path, start, end):
    with pool.connection() as conn:
        rows = conn.execute('''SELECT DISTINCT ON(start_at) * FROM segments
          WHERE path=%s AND start_at < %s AND start_at >= %s - interval '1 day'
          AND end_at > %s ORDER BY start_at,created_at,object_key LIMIT 10001''',
          (canonical_path(path), end, start, start)).fetchall()
    if len(rows) > 10000:
        raise HTTPException(413, 'Narrow the time range')
    return rows


@app.get('/healthz')
def healthz():
    return {'status': 'ok'}


@app.get('/readyz')
def readyz():
    try:
        with pool.connection() as conn:
            conn.execute('SELECT 1 FROM segments LIMIT 1')
        s3.head_bucket(Bucket=os.environ['S3_BUCKET'])
    except Exception:
        raise HTTPException(503, 'Archive dependencies unavailable')
    return {'status': 'ready'}


@app.get('/api/health')
def camera_health(request: Request, path: str):
    validate(path)
    authorize(request, path)
    with pool.connection() as conn:
        row = conn.execute('''SELECT *, CASE WHEN checked_at < now()-interval '30 seconds'
            THEN 'worker_unavailable' WHEN last_frame_at < now()-interval '30 seconds'
            THEN 'stalled' ELSE status END AS effective_status FROM camera_health WHERE path=%s''', (canonical_path(path),)).fetchone()
    if not row:
        raise HTTPException(404, 'Camera not assigned')
    return row


@app.get('/list')
def recordings(request: Request, path: str, start: str | None = None, end: str | None = None):
    first, last = validate(path, start, end)
    actor = authorize(request, path)
    rows = query(path, first, last)
    spans = []
    for row in rows:
        a, b = max(first, row['start_at']), min(last, row['end_at'])
        if spans and (a-spans[-1][1]).total_seconds() <= 0.15:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    result = []
    # Bound each returned playback URL to the synchronous export budget.
    for a, b in spans:
        while a < b:
            until = min(b, a+timedelta(seconds=3600))
            duration = (until-a).total_seconds()
            params = {'path': path, 'start': a.isoformat(), 'duration': duration,
                      'token': token(path, a, until, actor)}
            result.append({'start': a.isoformat(), 'duration': duration,
                           'url': os.environ['PUBLIC_PLAYBACK_URL'].rstrip('/')+'/get?'+urlencode(params)})
            a = until
    with pool.connection() as conn:
        audit(conn, path, actor, 'recordings.list', {'start': first.isoformat(), 'end': last.isoformat()})
    return result


@app.get('/get')
def playback(request: Request, path: str, start: str, duration: float, format: str = 'fmp4'):
    import math
    if not math.isfinite(duration) or not 0 < duration <= 3600 or format not in ('mp4', 'fmp4'):
        raise HTTPException(400, 'Duration must be 0–3600 seconds; format mp4 or fmp4')
    try:
        first = utc(start)
    except ValueError:
        raise HTTPException(400, 'Timezone-aware start required')
    last = first + timedelta(seconds=duration)
    validate(path, first.isoformat(), last.isoformat())
    actor = authorize(request, path, first, last)
    rows = query(path, first, last)
    if any((a['end_at']-b['start_at']).total_seconds() > 0.15 for a, b in zip(rows, rows[1:])):
        raise HTTPException(409, 'Overlapping recordings require a narrower range')
    if not rows or not coverage(rows, first, last):
        raise HTTPException(409, 'Requested range contains a recording gap; use /list for available spans')
    budget = int(os.environ.get('MAX_EXPORT_BYTES', str(2*1024**3)))
    size = sum(r['bytes'] for r in rows)
    if size > budget:
        raise HTTPException(413, 'Request a shorter clip')
    if not exports.acquire(blocking=False):
        raise HTTPException(429, 'Export capacity busy', headers={'Retry-After': '10'})
    folder = Path(tempfile.mkdtemp(prefix='recording-export-'))
    try:
        if shutil.disk_usage(folder).free < size*3 + 128*1024**2:
            raise HTTPException(503, 'Export scratch space unavailable')
        with pool.connection() as conn:
            audit(conn, path, actor, 'export.requested', {'start': start, 'duration': duration})
        for index, row in enumerate(rows):
            target = folder / f'{index}.mp4'
            s3.download_file(os.environ['S3_BUCKET'], row['object_key'], str(target))
            if target.stat().st_size != row['bytes'] or digest(target) != row['sha256']:
                raise HTTPException(502, 'Archive segment integrity verification failed')
        (folder / 'concat.txt').write_text(''.join(f"file '{i}.mp4'\n" for i in range(len(rows))))
        output = folder / 'export.mp4'
        cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', str(folder/'concat.txt'),
               '-ss', str(max(0, (first-rows[0]['start_at']).total_seconds())), '-t', str(duration), '-c', 'copy']
        cmd += ['-movflags', '+faststart' if format == 'mp4' else '+frag_keyframe+empty_moov+default_base_moof', str(output)]
        completed = subprocess.run(cmd, capture_output=True, timeout=180)
        if completed.returncode or not output.exists() or not output.stat().st_size:
            raise HTTPException(502, 'Clip assembly failed')
        sha = digest(output)
        with pool.connection() as conn:
            audit(conn, path, actor, 'export.prepared', {'start': start, 'duration': duration,
                'sha256': sha, 'bytes': output.stat().st_size,
                'segments': [{'key': r['object_key'], 'sha256': r['sha256']} for r in rows],
                'cut_mode': 'keyframe-aligned remux'})
        # Keep concurrency permit until the response finishes, including slow clients.
        def cleanup():
            shutil.rmtree(folder)
            exports.release()
        return FileResponse(output, media_type='video/mp4', headers={'X-Content-SHA256': sha,
                'Cache-Control': 'private, no-store'}, background=BackgroundTask(cleanup))
    except Exception:
        shutil.rmtree(folder)
        exports.release()
        with pool.connection() as conn:
            audit(conn, path, actor, 'export.failed', {'start': start, 'duration': duration})
        raise


@app.get('/metrics')
def metrics(request: Request):
    from fastapi.responses import PlainTextResponse
    authorize(request, 'stream/metrics')
    with pool.connection() as conn:
        counts = conn.execute("SELECT state,count(*) AS total FROM health_states GROUP BY state").fetchall()
        pending = conn.execute("SELECT count(*) AS total FROM notifications WHERE delivered_at IS NULL").fetchone()['total']
        lag = conn.execute("SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(due_at)),0) AS age FROM notifications WHERE delivered_at IS NULL").fetchone()['age']
    lines = ['# TYPE recording_cameras gauge']
    for row in counts:
        # State is produced internally by monitor.py, never copied from camera input.
        lines.append('recording_cameras{state="'+row['state']+'"} '+str(row['total']))
    lines += ['# TYPE recording_notifications_pending gauge', f'recording_notifications_pending {pending}',
              '# TYPE recording_notification_delay_seconds gauge', f'recording_notification_delay_seconds {max(0,lag)}']
    return PlainTextResponse('\n'.join(lines)+'\n')
