"""Initialize the independent database and load trusted deployment configuration."""
import json
import sys
from .models import Source
from .store import Store

if __name__ == '__main__':
    raw = json.load(open(sys.argv[1]))
    sources = [Source(**item) for item in (raw['sources'] if isinstance(raw, dict) else raw)]
    if len({s.id for s in sources}) != len(sources): raise ValueError('Duplicate source IDs')
    store = Store()
    try:
        store.migrate()
        store.configure(sources)
    finally: store.pool.close()
