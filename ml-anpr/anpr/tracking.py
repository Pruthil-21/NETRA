"""Per-plate confidence-weighted-voting confirmation, and per-vehicle IoU
tracking so that confirmation runs independently per physical vehicle."""
from .plate_format import INDIAN_PLATE_PATTERN, _plate_similarity


class PlateConfirmationTracker:
    """
    Real dashcam footage never OCR's the same plate to an identical string
    frame-to-frame (e.g. HR9BE4959 / HR98E4959 / HR9854952 for one real
    plate) — motion blur causes per-character substitution errors that
    drift the exact string every read, so exact-match confirmation never
    fires. This clusters same-length readings that are "close enough" to
    be the same plate, and reconstructs the most likely plate via
    confidence-weighted per-character voting across the cluster, instead
    of requiring an exact repeated string.

    Individual low-confidence readings are still worth clustering — a
    single 0.15-confidence read of a real plate is noise on its own, but
    several of them voting together can reconstruct a confident plate. So
    every OCR-filtered candidate is fed in regardless of its own
    confidence; the per-note confidence floor is only enforced against the
    cluster's peak confidence at confirmation time.
    """
    SIMILARITY_THRESHOLD = 0.7

    def __init__(self, window_size=10, confirm_threshold=2):
        self.window_size = window_size
        self.confirm_threshold = confirm_threshold
        self.clusters = []
        self.confirmed = set()

    def _find_cluster(self, plate):
        best_cluster, best_score = None, 0.0
        for cluster in self.clusters:
            score = _plate_similarity(cluster["representative"], plate)
            if score >= self.SIMILARITY_THRESHOLD and score > best_score:
                best_cluster, best_score = cluster, score
        return best_cluster

    # A raw reading that already matched the strict Indian-plate structure
    # on its own is much stronger evidence per character than a handful of
    # low-confidence fallback-tier misreads — without this, several noisy
    # "close enough" misreads can outvote a couple of genuinely correct
    # structural matches.
    PATTERN_MATCH_VOTE_WEIGHT = 2.5

    @classmethod
    def _reconstruct(cls, readings):
        """Per-character voting requires aligned positions, which only
        makes sense within one length. A cluster can hold readings of
        several lengths (edit-distance clustering tolerates dropped/
        inserted characters), so vote on the dominant length first, then
        vote characters only among readings of that length — the other
        lengths still count toward cluster membership, just not toward
        the reconstructed string."""
        length_weights = {}
        for plate, conf, note in readings:
            weight = conf * (cls.PATTERN_MATCH_VOTE_WEIGHT if note == "ok - pattern match" else 1.0)
            length_weights[len(plate)] = length_weights.get(len(plate), 0.0) + weight
        dominant_length = max(length_weights, key=length_weights.get)

        chars = []
        for i in range(dominant_length):
            votes = {}
            for plate, conf, note in readings:
                if len(plate) != dominant_length:
                    continue
                weight = conf * (cls.PATTERN_MATCH_VOTE_WEIGHT if note == "ok - pattern match" else 1.0)
                votes[plate[i]] = votes.get(plate[i], 0.0) + weight
            chars.append(max(votes, key=votes.get))
        return "".join(chars)

    def add(self, plate, confidence, note):
        """Feed one OCR-filtered reading in (any confidence). Returns a
        confirmed-event dict the first time a cluster crosses
        confirm_threshold AND its peak confidence clears the floor for its
        reconstructed note type, else None."""
        cluster = self._find_cluster(plate)
        if cluster is None:
            cluster = {"readings": [], "representative": plate}
            self.clusters.append(cluster)
            self.clusters = self.clusters[-20:]

        cluster["readings"].append((plate, confidence, note))
        cluster["readings"] = cluster["readings"][-self.window_size:]
        cluster["representative"] = self._reconstruct(cluster["readings"])

        if len(cluster["readings"]) < self.confirm_threshold:
            return None

        # A single real, hard-to-read plate can still split across two
        # incompatible-length clusters that never merge (e.g. flip-flopping
        # on whether an ambiguous character is even present) — each can
        # independently cross confirm_threshold. Rather than solve general
        # cluster merging, just refuse to fire a second alert for something
        # already close to an already-confirmed plate.
        if any(_plate_similarity(cluster["representative"], c) >= self.SIMILARITY_THRESHOLD for c in self.confirmed):
            return None

        best_conf = max(c for _, c, _ in cluster["readings"])
        reconstructed_note = "ok - pattern match" if INDIAN_PLATE_PATTERN.match(cluster["representative"]) \
            else "ok - fallback, unverified pattern"
        min_conf = 0.25 if reconstructed_note == "ok - pattern match" else 0.4
        if best_conf < min_conf:
            return None

        self.confirmed.add(cluster["representative"])
        return {
            "plate_number": cluster["representative"],
            "confidence": float(round(best_conf, 2)),
            "note": reconstructed_note,
        }


def _iou(box_a, box_b):
    """Intersection-over-union of two (x1,y1,x2,y2) boxes, 0.0 if disjoint."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / (area_a + area_b - inter)


class VehicleTracker:
    """
    Associates per-frame vehicle detections (detection.detect_plate_from_frame's
    list output, Session 7) into persistent per-vehicle tracks via
    frame-to-frame IoU matching, so PlateConfirmationTracker's
    similarity-based clustering runs independently per physical vehicle
    instead of pooling every vehicle seen in a stream into one shared
    set of clusters -- SIMILARITY_THRESHOLD=0.7 is permissive enough
    that two different real plates from two different vehicles could
    otherwise merge if they're superficially similar strings.

    Approach 1 from ALPR_IMPROVEMENT_LOG.md Session 7's design (tried
    first per instructions): greedy best-IoU matching against each
    track's last-seen box, no new dependency. Known risk, stated in the
    design before testing: process_video_file/process_stream only
    examine every Nth frame, so real displacement between *processed*
    frames is larger than true frame-to-frame motion -- this is
    exactly the condition IoU matching is weakest under. See Session 7
    for whether this held up on the real dashcam clip's actual sampling
    rate.
    """
    IOU_MATCH_THRESHOLD = 0.3
    MAX_MISSED_FRAMES = 5

    def __init__(self, window_size=10, confirm_threshold=2):
        self.window_size = window_size
        self.confirm_threshold = confirm_threshold
        self.tracks = []  # each: {"box": (x1,y1,x2,y2), "tracker": PlateConfirmationTracker, "missed": int}
        # Persists across track pruning -- a confirmed plate must not
        # silently disappear from the summary just because the vehicle
        # that produced it later left frame and its track got pruned.
        self.confirmed = set()

    def update(self, detections):
        """
        detections: detection.detect_plate_from_frame's list output for
        one frame. Returns a list of confirmed-event dicts for this frame
        (0 or more -- one per vehicle track that just crossed its own
        confirm_threshold).
        """
        confirmed_events = []
        matched = set()

        for det in detections:
            box = det.get("box")
            if box is None:
                continue

            best_track, best_iou = None, 0.0
            for t in self.tracks:
                if id(t) in matched:
                    continue
                iou = _iou(t["box"], box)
                if iou >= self.IOU_MATCH_THRESHOLD and iou > best_iou:
                    best_track, best_iou = t, iou

            if best_track is None:
                best_track = {
                    "box": box,
                    "tracker": PlateConfirmationTracker(
                        window_size=self.window_size, confirm_threshold=self.confirm_threshold
                    ),
                    "missed": 0,
                }
                self.tracks.append(best_track)

            best_track["box"] = box
            best_track["missed"] = 0
            matched.add(id(best_track))

            plate = det.get("plate_number")
            if not plate:
                continue
            confirmed = best_track["tracker"].add(plate, det["confidence"], det["note"])
            if confirmed:
                confirmed_events.append(confirmed)
                self.confirmed.add(confirmed["plate_number"])

        for t in self.tracks:
            if id(t) not in matched:
                t["missed"] += 1
        self.tracks = [t for t in self.tracks if t["missed"] <= self.MAX_MISSED_FRAMES]

        return confirmed_events
