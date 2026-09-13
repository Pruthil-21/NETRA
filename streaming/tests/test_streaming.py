"""Dependency-free regression checks; no real camera or credential is used."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class ReaderTests(unittest.TestCase):
    def setUp(self):
        cv = types.ModuleType('cv2')
        cv.Mat = object
        cv.VideoCapture = object
        cv.CAP_FFMPEG = 1
        cv.CAP_PROP_OPEN_TIMEOUT_MSEC = 53
        cv.CAP_PROP_READ_TIMEOUT_MSEC = 54
        cv.CAP_PROP_BUFFERSIZE = 38
        cv.INTER_LINEAR = 1
        spec = importlib.util.spec_from_file_location('reader_under_test', ROOT / 'rtsp_reader.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, cv2=cv): spec.loader.exec_module(self.module)
        self.reader = self.module.RTSPStreamReader('rtsp://fixture', reconnect_interval_sec=.01)

    def test_stale_and_stopped_frames_are_unavailable(self):
        reader = self.reader
        reader._frame_raw = reader._frame_infer = [1]
        reader._last_frame_monotonic = time.monotonic()
        self.assertTrue(reader.read_latest()[0])
        reader._last_frame_monotonic -= 3
        self.assertFalse(reader.read_latest()[0])
        reader.stop()
        self.assertFalse(reader.read_latest()[0])

    def test_double_start_does_not_spawn_second_capture(self):
        reader = self.reader
        reader._capture_loop = lambda: reader._stop.wait(2)
        reader.start()
        thread = reader._thread
        reader.start()
        self.assertIs(reader._thread, thread)
        reader.stop()
        self.assertFalse(thread.is_alive())

    def test_disconnect_clears_frames_and_worker_owns_release(self):
        reader = self.reader
        released = []
        class Capture:
            def isOpened(self): return True
            def read(self):
                reader._stop.set()
                return False, None
            def release(self): released.append(threading.get_ident())
        reader._cap = Capture()
        reader._frame_raw = reader._frame_infer = [1]
        reader.start()
        reader._thread.join(1)
        self.assertEqual(released, [reader._thread.ident])
        self.assertFalse(reader.read_latest()[0])

    def test_capture_receives_timeouts_and_preserves_operator_options(self):
        captured = []
        class Capture:
            def __init__(self, *args): captured.append(args)
            def set(self, *args): pass
            def isOpened(self): return True
        self.module.cv2.VideoCapture = Capture
        with patch.dict(os.environ, OPENCV_FFMPEG_CAPTURE_OPTIONS='rtsp_transport;udp'):
            self.assertTrue(self.reader._open_capture())
            self.assertEqual(os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'], 'rtsp_transport;udp')
        self.assertEqual(captured[0][2], [53, 3000, 54, 3000])


class RelayTests(unittest.TestCase):
    def test_recorded_ffmpeg_failure_retries(self):
        # Exercise the actual publisher function under errexit with a failing FFmpeg.
        script = (ROOT / 'docker/replay-entrypoint.sh').read_text()
        function = script[script.index('stream_file() ('):script.index('\nmapfile -t FILES')]
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'attempts'
            harness = '''set -Eeuo pipefail
MEDIAMTX_HOST=fixture
MEDIAMTX_PORT=8554
MEDIAMTX_PUBLISH_PASSWORD=fixture
STREAM_PREFIX=direct
TRANSCODE_CAMERAS='^never$'
ffmpeg() { echo attempt >> "$TEST_MARKER"; return 1; }
sleep() { if [ "$(wc -l < "$TEST_MARKER")" -ge 2 ]; then exit 0; fi; }
''' + function + '\nstream_file /fixture/cam01.mp4\n'
            result = subprocess.run(['bash', '-c', harness], env=dict(os.environ, TEST_MARKER=str(marker)),
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(marker.read_text().splitlines()), 2)

    def test_manifest_accepts_available_subset_and_rejects_unsafe_ids(self):
        script = (ROOT / 'docker/live-entrypoint.sh').read_text()
        expression = script.split('--argjson camera_limit "$CAMERA_LIMIT" \\\n', 1)[1].split("'", 2)[1]
        for payload, valid in [('[{"id":"cam01"}]', True), ('[]', False),
                               ('[{"id":"../../bad"}]', False),
                               ('[{"id":"cam01"},{"id":"cam01"}]', False)]:
            result = subprocess.run(['jq', '-e', '--argjson', 'camera_limit', '30', expression],
                                    input=payload, text=True, capture_output=True)
            self.assertEqual(result.returncode == 0, valid, result.stderr)


if __name__ == '__main__': unittest.main()
