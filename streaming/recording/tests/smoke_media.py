"""Real native MediaMTX → completed spool → remux export; no camera credentials."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import yaml

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    with tempfile.TemporaryDirectory(prefix='recording-smoke-') as temp:
        folder = Path(temp)
        config = yaml.safe_load((ROOT/'mediamtx.yml').read_text())
        port = free_port()
        config['rtspAddress'] = f'127.0.0.1:{port}'
        config['metricsAddress'] = f'127.0.0.1:{free_port()}'
        config['pathDefaults']['recordPath'] = str(folder/'segments/%path/%Y-%m-%d_%H-%M-%S-%f')
        config['pathDefaults']['recordSegmentDuration'] = '2s'
        config['pathDefaults']['runOnRecordSegmentComplete'] = f'{sys.executable} {ROOT}/hook.py'
        (folder/'config.yml').write_text(yaml.safe_dump(config))
        env = dict(os.environ, SPOOL=str(folder), TZ='UTC')
        with (folder/'mtx.log').open('w') as log:
            mtx = subprocess.Popen([str(ROOT.parent/'mediamtx'), str(folder/'config.yml')], stdout=log, stderr=log, env=env)
            try:
                time.sleep(1)
                assert mtx.poll() is None, (folder/'mtx.log').read_text()
                result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-re', '-f', 'lavfi', '-i',
                    'testsrc2=size=320x240:rate=10', '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast',
                    '-g', '10', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp',
                    f'rtsp://127.0.0.1:{port}/stream/test'], capture_output=True, timeout=25)
                assert result.returncode == 0, result.stderr.decode()
                time.sleep(2)
                markers = sorted(folder.glob('segments/stream/test/*.json'))
                assert len(markers) >= 3, (folder/'mtx.log').read_text()
                for marker in markers:
                    assert json.loads(marker.read_text())['duration'] > 0
                    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(marker.with_suffix('.mp4')),
                                        '-frames:v', '1', '-f', 'null', '-'], capture_output=True, timeout=10)
                    assert r.returncode == 0, r.stderr.decode()
                # Exercise real archive API export with local storage and audit doubles.
                sys.path.insert(0, str(ROOT))
                import api
                from core import digest
                from datetime import datetime, timezone, timedelta
                from unittest.mock import patch
                from starlette.requests import Request
                from contextlib import contextmanager
                rows = []
                for marker in markers:
                    start = datetime.strptime(marker.stem, '%Y-%m-%d_%H-%M-%S-%f').replace(tzinfo=timezone.utc)
                    rows.append({'start_at': start, 'end_at': start+timedelta(seconds=json.loads(marker.read_text())['duration']),
                                 'object_key': str(marker.with_suffix('.mp4')), 'sha256': digest(marker.with_suffix('.mp4')),
                                 'bytes': marker.with_suffix('.mp4').stat().st_size})
                class DB:
                    @contextmanager
                    def connection(self):
                        yield self
                class Store:
                    def download_file(self, bucket, key, target):
                        shutil.copyfile(key, target)
                request = Request({'type': 'http', 'headers': [(b'x-service-key', b'b'*40), (b'x-actor-id', b'officer1')], 'query_string': b''})
                import asyncio
                with patch.dict(os.environ, {'RECORDING_SERVICE_KEY': 'b'*40, 'S3_BUCKET': 'test'}), \
                     patch.object(api, 'pool', DB()), patch.object(api, 's3', Store()), \
                     patch.object(api, 'query', return_value=rows), patch.object(api, 'audit') as audit:
                    response = api.playback(request, 'stream/test', rows[0]['start_at'].isoformat(), 4, 'mp4')
                    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(response.path), '-f', 'null', '-'], capture_output=True, timeout=10)
                    assert decoded.returncode == 0, decoded.stderr.decode()
                    assert response.headers['x-content-sha256'] == digest(response.path)
                    assert audit.call_args[0][3] == 'export.prepared'
                    asyncio.run(response.background())
                    rows[0]['sha256'] = '0'*64
                    try:
                        api.playback(request, 'stream/test', rows[0]['start_at'].isoformat(), 4, 'mp4')
                        raise AssertionError('Corruption not rejected')
                    except api.HTTPException as error:
                        assert error.status_code == 502
                print(json.dumps({'completed_segments': len(markers), 'viewer_required': False,
                                  'export_decoded': True, 'corruption_rejected': True}))
            finally:
                mtx.terminate()
                mtx.wait(timeout=10)

if __name__ == '__main__':
    main()
