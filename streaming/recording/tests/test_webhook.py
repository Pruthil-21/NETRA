"""Registry webhook contract tests; never send events to the real backend."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import monitor


class Pool:
    def __init__(self):
        self.row = {'event_id': uuid.uuid4(), 'path': 'stream/demo-cam67',
                    'state': 'feed_lost', 'attempts': 0,
                    'payload': {'state': 'feed_lost', 'at': '2026-09-08T00:00:00Z', 'shard': 'edge-0'}}
        self.updates = []

    @contextmanager
    def connection(self):
        yield self

    def execute(self, sql, args=None):
        if sql.startswith('UPDATE'):
            self.updates.append((sql, args))
        return self

    def fetchone(self):
        return self.row


class WebhookTests(unittest.TestCase):
    def test_contract_and_stable_id_on_retry(self):
        pool = Pool()
        sent = []
        def post(url, **kwargs):
            sent.append(kwargs)
            if len(sent) == 1:
                return httpx.Response(503, request=httpx.Request('POST', url))
            return httpx.Response(202, json={'event_id': str(pool.row['event_id']), 'status': 'accepted'},
                                  request=httpx.Request('POST', url))
        with patch.dict(os.environ, {'NOTIFICATION_WEBHOOK':'http://registry.test/recordings/health-events',
                                      'NOTIFICATION_WEBHOOK_KEY':'test-only-key'}), patch.object(monitor.httpx, 'post', post):
            monitor.deliver(pool)
            monitor.deliver(pool)
        self.assertIn('attempts=attempts+1', pool.updates[0][0])
        self.assertIn('delivered_at=now()', pool.updates[1][0])
        self.assertEqual(sent[0]['json'], sent[1]['json'])
        self.assertEqual(sent[1]['headers']['X-Webhook-Key'], 'test-only-key')
        self.assertNotIn('X-Service-Key', sent[1]['headers'])
        self.assertEqual(sent[1]['json']['status'], 'feed_lost')
        self.assertEqual(sent[1]['json']['occurred_at'], pool.row['payload']['at'])
        self.assertNotIn('state', sent[1]['json'])

    def test_wrong_event_acknowledgment_is_retried(self):
        pool = Pool()
        response = httpx.Response(202, json={'event_id':'wrong', 'status':'accepted'},
                                  request=httpx.Request('POST', 'http://registry.test'))
        with patch.dict(os.environ, {'NOTIFICATION_WEBHOOK':'http://registry.test/recordings/health-events',
                                      'NOTIFICATION_WEBHOOK_KEY':'test-only-key'}), \
             patch.object(monitor.httpx, 'post', return_value=response):
            monitor.deliver(pool)
        self.assertIn('attempts=attempts+1', pool.updates[0][0])

if __name__ == '__main__':
    unittest.main()
