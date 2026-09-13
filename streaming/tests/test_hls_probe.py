import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.sequence=1
        self.invalid=False
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                if owner.invalid:
                    body='<!doctype html>login required'
                elif self.path.startswith('/index'):
                    body='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nstream.m3u8\n'
                else:
                    body=f'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:{owner.sequence}\n#EXTINF:1,\nseg{owner.sequence}.mp4\n'
                data=body.encode();self.send_response(200);self.send_header('Content-Length',str(len(data)))
                self.end_headers();self.wfile.write(data)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.temp=tempfile.TemporaryDirectory()
        self.state=Path(self.temp.name)/'cam01'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.temp.cleanup()

    def probe(self):
        return subprocess.run(['bash',str(ROOT/'docker/hls-probe.sh'),
            f'http://127.0.0.1:{self.server.server_port}/index.m3u8',str(self.state),'5'],capture_output=True).returncode

    def test_advancement_stall_and_recovery(self):
        self.assertEqual(self.probe(),0)
        progress=self.state.with_suffix('.progress')
        _,fingerprint=progress.read_text().strip().split('|',1)
        progress.write_text(f'{int(time.time())-20}|{fingerprint}\n')
        self.assertNotEqual(self.probe(),0)
        self.sequence+=1
        self.assertEqual(self.probe(),0)

    def test_http_200_html_is_not_video(self):
        self.invalid=True
        self.assertNotEqual(self.probe(),0)

    def test_health_requires_fresh_probe_and_camera_quorum(self):
        runtime=Path(self.temp.name)
        (runtime/'status').mkdir()
        (runtime/'cameras.json').write_text('[{"id":"cam01"}]')
        (runtime/'auth-success').write_text(str(int(time.time())))
        (runtime/'status/cam01').write_text('online')
        checked=runtime/'status/cam01.checked'
        checked.write_text(str(int(time.time())))
        def health(required):
            return subprocess.run(['sh',str(ROOT/'docker/live-healthcheck.sh')],capture_output=True,
                env=dict(os.environ,RUNTIME_DIR=str(runtime),MIN_ONLINE_CAMERAS=str(required))).returncode
        self.assertEqual(health(1),0)
        self.assertNotEqual(health(2),0)
        checked.write_text(str(int(time.time())-60))
        self.assertNotEqual(health(1),0)


class MonitorTests(unittest.TestCase):
    def test_invalid_mock_configuration_is_rejected(self):
        spec=importlib.util.spec_from_file_location('monitor',ROOT/'snmp/monitor.py')
        monitor=importlib.util.module_from_spec(spec);spec.loader.exec_module(monitor)
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'targets.json'
            for value in [[],{'camera_limit':True},{'camera_limit':100000},{'mock_states':[]}]:
                config.write_text(json.dumps(value))
                with patch.object(monitor,'TARGETS_FILE',config):
                    with self.assertRaises(RuntimeError): monitor.load_config()


if __name__=='__main__': unittest.main()
