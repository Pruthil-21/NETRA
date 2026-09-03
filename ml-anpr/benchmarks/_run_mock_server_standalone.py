"""Runs the mock backend server as a standalone OS process (not a thread
inside the load-test's own process) so it has its own GIL/CPU, same as
a real separate backend service would. Prints its URL on the first line
so the parent process can read it, then blocks forever until killed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmarks.mock_backend_server import MockBackendServer

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = MockBackendServer(port=port).start()
    print(server.url, flush=True)
    try:
        while True:
            import time
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()
