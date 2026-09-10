import os
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Ring, coverage, digest, retry_delay, stream_path, utc


class CoreTests(unittest.TestCase):
    def test_100001_camera_placement_and_bounded_movement(self):
        before = Ring([f'shard-{i}' for i in range(256)])
        after = Ring([f'shard-{i}' for i in range(257)])
        counts = {}
        moved = 0
        for i in range(100001):
            key = f'stream/camera-{i}'
            owner = before.owner(key)
            counts[owner] = counts.get(owner, 0)+1
            if owner != after.owner(key):
                moved += 1
                self.assertEqual(after.owner(key), 'shard-256')
        self.assertEqual(sum(counts.values()), 100001)
        self.assertLess(max(counts.values()), 500)
        self.assertLess(moved, 1500)

    def test_reject_paths_and_ambiguous_time(self):
        for path in ('../secret', 'stream/../../secret', 'stream/a\n', 'stream/a/b', ''):
            with self.assertRaises(ValueError):
                stream_path(path)
        with self.assertRaises(ValueError):
            utc('2026-01-01T00:00:00')

    def test_gap_not_silently_exported(self):
        t = datetime.now(timezone.utc)
        rows = [{'start_at': t, 'end_at': t+timedelta(seconds=10)},
                {'start_at': t+timedelta(seconds=15), 'end_at': t+timedelta(seconds=30)}]
        self.assertFalse(coverage(rows, t, t+timedelta(seconds=30)))
        self.assertTrue(coverage(rows[:1], t, t+timedelta(seconds=10)))

    def test_backoff_bounded_nonzero(self):
        for n in range(100):
            self.assertGreaterEqual(retry_delay(n, 0), 1)
            self.assertLessEqual(retry_delay(n, 1), 60)

    def test_tokens_bound_actor_camera_range_and_expiry(self):
        import api
        from starlette.requests import Request
        from fastapi import HTTPException
        env = {'PLAYBACK_SIGNING_KEY': 'a'*40, 'RECORDING_SERVICE_KEY': 'b'*40}
        a = utc('2026-01-01T00:00:00Z')
        b = a+timedelta(seconds=10)
        def request(tok):
            return Request({'type': 'http', 'headers': [], 'query_string': ('token='+tok).encode()})
        with patch.dict(os.environ, env):
            tok = api.token('stream/cam1', a, b, 'officer1')
            self.assertEqual(api.authorize(request(tok), 'stream/cam1', a, b), 'officer1')
            for path, end in [('stream/cam2', b), ('stream/cam1', b+timedelta(seconds=1))]:
                with self.assertRaises(HTTPException):
                    api.authorize(request(tok), path, a, end)
            with patch('api.time.time', return_value=10**12), self.assertRaises(HTTPException):
                api.authorize(request(tok), 'stream/cam1', a, b)

    def test_render_capacity_and_private_ingress(self):
        from render_fleet import render
        docs, counts = render([{'path': 'stream/a', 'source': 'rtsp://camera/a'}], ['edge-0'],
                             'example/image:tested', 'replicated-storage', True)
        self.assertEqual(counts, {'edge-0': 1})
        self.assertTrue(any(d['kind'] == 'NetworkPolicy' for d in docs))
        shard = next(d for d in docs if d['kind'] == 'StatefulSet')
        self.assertEqual(shard['spec']['volumeClaimTemplates'][0]['spec']['accessModes'], ['ReadWriteOncePod'])
        with self.assertRaises(ValueError):
            render([{'path': 'stream/a', 'source': 'rtsp://camera/a'}], ['edge-0'], 'img', 'disk', capacity=0)

if __name__ == '__main__':
    unittest.main()

class UploadTests(unittest.TestCase):
    def test_upload_failure_keeps_durable_spool_and_no_receipt(self):
        import worker
        from contextlib import contextmanager
        import json
        class BrokenStorage:
            def upload_file(self, *args, **kwargs):
                raise OSError('unavailable')
        with tempfile.TemporaryDirectory() as folder:
            segment = Path(folder)/'2026-09-08_12-00-00-000000.mp4'
            segment.write_bytes(b'completed segment')
            marker = segment.with_suffix('.json')
            marker.write_text(json.dumps({'path':'stream/cam1', 'duration':60}))
            with patch.dict(os.environ, {'S3_BUCKET':'test'}), self.assertRaises(OSError):
                worker.upload(marker, None, BrokenStorage())
            self.assertTrue(segment.exists())
            self.assertTrue(marker.exists())
            self.assertFalse(segment.with_suffix('.uploaded').exists())

    def test_repeated_archive_does_not_duplicate_audit(self):
        import worker
        from contextlib import contextmanager
        import json
        class Pool:
            inserted = False
            @contextmanager
            def connection(self):
                yield self
            def execute(self, statement, args):
                if statement.startswith('INSERT'):
                    self.result = None if self.inserted else {'path':'stream/cam1'}
                    self.inserted = True
                return self
            def fetchone(self):
                return self.result
        class Store:
            def upload_file(self, *args, **kwargs):
                pass
        with tempfile.TemporaryDirectory() as folder:
            segment = Path(folder)/'2026-09-08_12-00-00-000000.mp4'
            segment.write_bytes(b'completed segment')
            marker = segment.with_suffix('.json')
            marker.write_text(json.dumps({'path':'stream/cam1', 'duration':60}))
            with patch.dict(os.environ, {'S3_BUCKET':'test'}), patch.object(worker, 'audit') as audit:
                pool = Pool()
                worker.upload(marker, pool, Store())
                worker.upload(marker, pool, Store())
                self.assertEqual(audit.call_count, 1)
                self.assertEqual(segment.with_suffix('.uploaded').read_text(), digest(segment))
