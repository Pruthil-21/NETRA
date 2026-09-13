"""Pure recording primitives; stream IDs are supplied by the registry."""
import bisect
import hashlib
import re
from datetime import datetime, timezone

PATH = re.compile(r"stream/[A-Za-z0-9_-]{1,128}\Z")


def stream_path(value):
    if not isinstance(value, str) or not PATH.fullmatch(value):
        raise ValueError("Expected an existing stream/<id> path")
    return value


def utc(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timezone required")
    return result.astimezone(timezone.utc)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def retry_delay(attempt, random_value):
    # Equal jitter: no zero-delay reconnect storm, capped at 60 seconds.
    ceiling = min(60, 2 ** min(attempt + 1, 6))
    return ceiling / 2 + random_value * ceiling / 2


class Ring:
    def __init__(self, nodes, replicas=256):
        if not nodes or len(set(nodes)) != len(nodes):
            raise ValueError("Unique nonempty shard names required")
        points = sorted((self.hash(f"{n}:{i}"), n) for n in nodes for i in range(replicas))
        self.points, self.nodes = zip(*points)

    @staticmethod
    def hash(value):
        return int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big")

    def owner(self, camera_id):
        return self.nodes[bisect.bisect_left(self.points, self.hash(camera_id)) % len(self.points)]


def coverage(rows, start, end, tolerance=0.15):
    """Never silently join an archive gap into an apparently continuous export."""
    cursor = start
    for row in rows:
        if (row["start_at"] - cursor).total_seconds() > tolerance:
            return False
        cursor = max(cursor, row["end_at"])
    return (end - cursor).total_seconds() <= tolerance


def playback_plan(rows, start, end):
    """First segment wins overlapping time; return disjoint half-open media slices.

    Original media and timestamps remain untouched. A later segment contributes
    only time not already covered, including when it is completely nested.
    """
    cursor = start
    parts = []
    for index, row in enumerate(rows):
        a, b = max(start, cursor, row['start_at']), min(end, row['end_at'])
        if a < b:
            parts.append({'index': index, 'start': a, 'end': b,
                          'offset': (a-row['start_at']).total_seconds(),
                          'duration': (b-a).total_seconds()})
            cursor = b
    return parts


def has_overlap(rows):
    cursor = None
    for row in rows:
        if cursor is not None and row['start_at'] < cursor:
            return True
        cursor = max(cursor, row['end_at']) if cursor else row['end_at']
    return False
