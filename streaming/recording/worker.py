"""One bounded shard: supervised remux publishers and durable S3 upload spool."""
import asyncio
from collections import deque
import json
import logging
import os
from pathlib import Path
import random
import shutil
import signal
import subprocess
import time
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor

from common import audit, database, storage
from core import Ring, digest, retry_delay, stream_path

log = logging.getLogger('recorder')
ROOT = Path(os.environ.get('SPOOL', '/spool'))
SHARD = os.environ.get('SHARD_ID', 'pilot-0')


def load_cameras():
    rows = json.loads(Path(os.environ.get('CAMERAS_FILE', '/config/cameras.json')).read_text())
    if len(rows) > int(os.environ.get('MAX_CAMERAS_PER_SHARD', '500')):
        raise ValueError('Shard exceeds its configured camera budget')
    seen = set()
    for row in rows:
        path = stream_path(row['path'])
        if path in seen or row.get('codec', 'copy') not in ('copy', 'h264'):
            raise ValueError('Duplicate camera or invalid codec strategy')
        seen.add(path)
        if not row['source'].startswith(('rtsp://', 'rtsps://', 'http://', 'https://')):
            raise ValueError('Unsupported source protocol')
    return rows


def upload(marker, pool, s3):
    segment = marker.with_suffix('.mp4')
    data = json.loads(marker.read_text())
    path = stream_path(data['path'])
    start = datetime.strptime(segment.stem, '%Y-%m-%d_%H-%M-%S-%f').replace(tzinfo=timezone.utc)
    duration = float(data['duration'])
    if not 0 < duration < 86400:
        raise ValueError('Invalid segment duration')
    sha = digest(segment)
    key = f'segments/{path}/{start:%Y/%m/%d}/{segment.stem}-{sha}.mp4'
    # Upload before committing index. Repeating either operation is idempotent.
    s3.upload_file(str(segment), os.environ['S3_BUCKET'], key,
                   ExtraArgs={'Metadata': {'sha256': sha, 'shard': SHARD}})
    with pool.connection() as conn:
        row = conn.execute('''INSERT INTO segments(path,start_at,end_at,object_key,sha256,bytes,shard,recovered)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING path''',
            (path, start, start + timedelta(seconds=duration), key, sha,
             segment.stat().st_size, SHARD, data.get('recovered', False))).fetchone()
        if row:
            audit(conn, path, SHARD, 'segment.archived', {'object_key': key, 'sha256': sha,
                  'start': start.isoformat(), 'duration': duration, 'recovered': data.get('recovered', False)})
        conn.execute('UPDATE camera_health SET last_segment_at=GREATEST(last_segment_at,%s) WHERE path=%s',
                     (start + timedelta(seconds=duration), path))
    receipt = marker.with_suffix('.uploaded')
    with receipt.open('w') as f:
        f.write(sha)
        f.flush()
        os.fsync(f.fileno())


def recover_completed_files():
    # Called before publishers start. ffprobe rejects unreadable interrupted files;
    # usable crash remnants are explicitly labelled recovered, not complete.
    for segment in (ROOT / 'segments').glob('stream/*/*.mp4'):
        marker = segment.with_suffix('.json')
        if marker.exists() or segment.with_suffix('.uploaded').exists():
            continue
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'json', str(segment)], capture_output=True, timeout=30)
        try:
            duration = float(json.loads(result.stdout)['format']['duration'])
            if result.returncode or duration <= 0:
                raise ValueError()
            marker.write_text(json.dumps({'path': str(segment.parent.relative_to(ROOT / 'segments')),
                                          'duration': duration, 'recovered': True}))
        except (ValueError, KeyError):
            log.error('Unreadable crash segment retained: %s', segment.name)


async def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    pool, s3 = database(), storage()
    cameras = load_cameras()
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)
    state = {r['path']: {'last': None, 'retries': 0} for r in cameras}
    # Dedicated session lock prevents accidental duplicate shard deployment.
    import psycopg
    lease = psycopg.connect(os.environ['DATABASE_URL'], autocommit=True, connect_timeout=5,
                           options='-c statement_timeout=5000')
    if not lease.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,0))', (SHARD,)).fetchone()[0]:
        raise RuntimeError('Shard already owned')
    await asyncio.to_thread(recover_completed_files)
    mtx = await asyncio.create_subprocess_exec('mediamtx', '/app/mediamtx.yml')
    await asyncio.sleep(1)
    capacity_ok = True

    async def publisher(row):
        nonlocal capacity_ok
        await asyncio.sleep(random.uniform(0, 5))
        health = state[row['path']]
        while not stopping.is_set():
            if not capacity_ok:
                await asyncio.sleep(2)
                continue
            cmd = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error']
            if row['source'].startswith(('rtsp://', 'rtsps://')):
                cmd += ['-rtsp_transport', 'tcp', '-timeout', '15000000']
            else:
                cmd += ['-rw_timeout', '15000000']
            cmd += ['-i', row['source'], '-map', '0:v:0', '-map', '0:a?', '-c', 'copy']
            if row.get('codec') == 'h264':
                cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
                        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac']
            cmd += ['-progress', 'pipe:1', '-stats_period', '2', '-f', 'rtsp',
                    '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:8554/' + row['path']]
            # Camera URLs/passwords can appear in ffmpeg stderr. Do not persist them.
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            previous, advanced = -1, time.monotonic()
            last_frame, frame = -1, -1
            began = advanced
            try:
                while not stopping.is_set() and capacity_ok:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
                    if not line:
                        break
                    if line.startswith(b'frame='):
                        try:
                            frame = int(line.split(b'=')[1])
                        except ValueError:
                            pass
                    if line.startswith(b'out_time_us='):
                        try:
                            value = int(line.split(b'=')[1])
                            if value > previous and value > 0 and frame > last_frame and frame > 0:
                                health['last'] = datetime.now(timezone.utc)
                                advanced, previous, last_frame = time.monotonic(), value, frame
                        except ValueError:
                            pass
                    if time.monotonic() - advanced > 30:
                        break
            except asyncio.TimeoutError:
                pass
            finally:
                if proc.returncode is None:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(proc.wait(), 8)
                    except asyncio.TimeoutError:
                        proc.kill()
                        await proc.wait()
            if stopping.is_set():
                break
            health['retries'] = 0 if time.monotonic() - began > 120 else health['retries'] + 1
            try:
                await asyncio.wait_for(stopping.wait(), retry_delay(health['retries'], random.random()))
            except asyncio.TimeoutError:
                pass

    executor = ThreadPoolExecutor(max_workers=int(os.environ.get('UPLOAD_WORKERS', '4')))
    pending, failures, next_try = {}, {}, {}
    discovered = deque()
    queued = set()

    async def spool():
        last_scan = 0
        last_cleanup = 0
        while not stopping.is_set():
            for marker, future in list(pending.items()):
                if future.done():
                    try:
                        future.result()
                        failures.pop(marker, None)
                        next_try.pop(marker, None)
                    except Exception:
                        failures[marker] = failures.get(marker, 0) + 1
                        next_try[marker] = time.monotonic() + retry_delay(failures[marker], random.random())
                        log.error('Upload deferred; segment retained: %s', marker.name)
                    del pending[marker]
            if time.monotonic()-last_cleanup > 60:
                # Cleanup is restricted to acknowledged generated runtime segments.
                cutoff = time.time()-int(os.environ.get('HOT_BUFFER_SECONDS', '3600'))
                for receipt in (ROOT / 'segments').glob('stream/*/*.uploaded'):
                    if receipt.stat().st_mtime < cutoff:
                        for item in (receipt.with_suffix('.mp4'), receipt.with_suffix('.json'), receipt):
                            item.unlink(missing_ok=True)
                last_cleanup = time.monotonic()
            if time.monotonic()-last_scan > 5 and len(discovered) < 1000:
                for marker in (ROOT / 'segments').glob('stream/*/*.json'):
                    if len(discovered) >= 1000:
                        break
                    if marker in pending or marker in queued or marker.with_suffix('.uploaded').exists():
                        continue
                    if next_try.get(marker, 0) > time.monotonic():
                        continue
                    discovered.append(marker)
                    queued.add(marker)
                last_scan = time.monotonic()
            while discovered and len(pending) < executor._max_workers:
                marker = discovered.popleft()
                queued.remove(marker)
                pending[marker] = executor.submit(upload, marker, pool, s3)
            await asyncio.sleep(0.1)

    def persist_health():
        now = datetime.now(timezone.utc)
        lease.execute('SELECT 1')  # fail closed if ownership connection is lost
        with pool.connection() as conn:
            with conn.cursor() as cur:
                cur.executemany('''INSERT INTO camera_health(path,shard,last_frame_at,status,retries,bucket)
                    VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(path) DO UPDATE SET
                    shard=excluded.shard,last_frame_at=COALESCE(excluded.last_frame_at,camera_health.last_frame_at),
                    checked_at=now(),status=excluded.status,retries=excluded.retries,bucket=excluded.bucket''',
                    [(path, SHARD, h['last'], 'disk_full' if not capacity_ok else 'recording' if h['last'] and
                      (now-h['last']).total_seconds() < 30 and capacity_ok else 'stalled' if h['last'] else 'never_connected',
                      h['retries'], Ring.hash(path)%64) for path, h in state.items()])

    tasks = [asyncio.create_task(publisher(row)) for row in cameras]
    tasks.append(asyncio.create_task(spool()))
    try:
        while not stopping.is_set():
            capacity_ok = shutil.disk_usage(ROOT).free > int(os.environ.get('MIN_FREE_BYTES', str(5*1024**3)))
            await asyncio.to_thread(persist_health)
            if mtx.returncode is not None or any(t.done() for t in tasks):
                raise RuntimeError('Required recording process stopped')
            (ROOT / 'worker.alive').write_text(str(time.time()))
            (ROOT / 'worker.ready').write_text(str(time.time()) if capacity_ok else '0')
            try:
                await asyncio.wait_for(stopping.wait(), 10)
            except asyncio.TimeoutError:
                pass
    finally:
        stopping.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        if mtx.returncode is None:
            mtx.terminate()
            await mtx.wait()
        executor.shutdown(wait=True)
        lease.close()
        pool.close()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
