"""Called by MediaMTX only after segment completion; spool before network I/O."""
import json
import os
from pathlib import Path
import uuid

root = Path(os.environ.get('SPOOL', '/spool')).resolve()
segment = Path(os.environ['MTX_SEGMENT_PATH']).resolve()
segment.relative_to(root / 'segments')
marker = segment.with_suffix('.json')
tmp = marker.with_name(marker.name + '.' + uuid.uuid4().hex + '.tmp')
with tmp.open('x') as f:
    json.dump({'path': os.environ['MTX_PATH'], 'duration': float(os.environ['MTX_SEGMENT_DURATION']),
               'recovered': False}, f)
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, marker)
fd = os.open(marker.parent, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
