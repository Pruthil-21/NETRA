"""Per-plate confidence-weighted-voting confirmation, and per-vehicle IoU
tracking so that confirmation runs independently per physical vehicle."""
import time
from concurrent.futures import ThreadPoolExecutor

from .plate_format import INDIAN_PLATE_PATTERN, _plate_similarity
from . import vlm_fallback


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

    # A track can lose and re-acquire the same physical vehicle -- e.g.
    # another car briefly blocking it for more than MAX_MISSED_FRAMES.
    # PlateConfirmationTracker only refuses to re-confirm within ITS OWN
    # track, so the broken-and-reformed track for the same real vehicle
    # would otherwise log it a second time. This window suppresses that
    # without suppressing a genuinely later, separate sighting of the same
    # plate on this camera (e.g. the same car passing again hours later) --
    # bounded, not a permanent "never again".
    RECONFIRM_COOLDOWN_SEC = 45

    # A track seen only once or twice before losing it is as likely to be
    # a spurious/noise detection as a real missed vehicle -- not worth an
    # expensive VLM call. Two real matches is the same bar
    # PlateConfirmationTracker's own default confirm_threshold uses.
    VLM_FALLBACK_MIN_MATCHES = 2

    def __init__(self, window_size=10, confirm_threshold=2):
        self.window_size = window_size
        self.confirm_threshold = confirm_threshold
        self.tracks = []  # each: {"box", "tracker": PlateConfirmationTracker, "missed",
                           #        "best_crop", "best_crop_area", "match_count", "vlm_dispatched"}
        # Two different lifetimes, two different structures -- conflating
        # them into one caused a real bug (see ALPR_IMPROVEMENT_LOG.md):
        # a long real run's final "Total confirmed plates" print showed
        # only ~13 of ~85 actually-confirmed plates, because the dict
        # backing it was being pruned down to the last
        # RECONFIRM_COOLDOWN_SEC the whole time.
        #
        # _recent_confirmations: plate -> last-confirmed monotonic
        # timestamp, pruned continuously -- internal, cooldown-suppression
        # only (see RECONFIRM_COOLDOWN_SEC). Never read externally.
        self._recent_confirmations = {}
        # confirmed_plates: every plate confirmed this whole session,
        # permanent, never pruned -- persists across track pruning too, so
        # a confirmed plate doesn't vanish from the summary just because
        # its vehicle later left frame. This is what callers should read.
        self.confirmed_plates = set()

        # One distinct vehicle sighting per new track created (item requested
        # for the presentation numbers: "how many cars were detected" --
        # previously not counted anywhere, only plate reads/confirmations
        # were). Counts sightings, not unique physical cars -- the same car
        # leaving and re-entering frame is a new track and counts again,
        # same honest caveat RECONFIRM_COOLDOWN_SEC's docstring already
        # states for confirmed_plates.
        self.total_vehicles_tracked = 0
        # Every per-frame OCR read with a non-empty plate guess, confirmed
        # or not -- "how many plate candidates" for the presentation.
        self.total_plate_candidates = 0
        # note -> count of confirmed plates in that tier ("ok - pattern
        # match" / "ok - fallback, unverified pattern" / "ok - vlm
        # fallback") -- the tier breakdown requested for the presentation.
        self.confirmed_by_tier = {}

        # BLPR-style last-resort fallback (see vlm_fallback.py): dispatched
        # in the background because measured Ollama latency (0.48s warm /
        # 6.7s cold -- see ALPR_IMPROVEMENT_LOG.md) is too slow to block
        # this per-frame update() loop. Bounded pool size doubles as a
        # natural rate limit if many tracks get pruned in the same burst.
        self._vlm_executor = ThreadPoolExecutor(max_workers=2)
        self._vlm_pending = []

    def _recently_confirmed(self, plate):
        """True if `plate` (or something close enough to be the same real
        plate) was confirmed on this camera within RECONFIRM_COOLDOWN_SEC.
        Also prunes expired entries while it's here, so
        _recent_confirmations stays bounded over a long-running stream
        without a separate cleanup pass."""
        now = time.monotonic()
        self._recent_confirmations = {
            p: t for p, t in self._recent_confirmations.items() if now - t < self.RECONFIRM_COOLDOWN_SEC
        }
        return any(_plate_similarity(plate, p) >= PlateConfirmationTracker.SIMILARITY_THRESHOLD
                   for p in self._recent_confirmations)

    def _mark_confirmed(self, plate, note):
        self._recent_confirmations[plate] = time.monotonic()
        self.confirmed_plates.add(plate)
        self.confirmed_by_tier[note] = self.confirmed_by_tier.get(note, 0) + 1

    def update(self, detections, raw_frame=None):
        """
        detections: detection.detect_plate_from_frame's list output for
        one frame. raw_frame: the same full frame passed to
        detect_plate_from_frame, optional -- used only to cache each
        track's best (largest-area) vehicle crop for the VLM fallback
        below; omitting it (existing callers are unaffected) just means
        that fallback never has an image to work with, not an error.

        Returns a list of confirmed-event dicts for this frame (0 or
        more -- one per vehicle track that just crossed its own
        confirm_threshold). VLM-fallback confirmations complete
        asynchronously and do NOT come out of this return value -- call
        pop_ready_vlm_confirmations() once per frame to collect those.
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
                    "best_crop": None,
                    "best_crop_area": 0,
                    "match_count": 0,
                    "vlm_dispatched": False,
                }
                self.tracks.append(best_track)
                self.total_vehicles_tracked += 1

            best_track["box"] = box
            best_track["missed"] = 0
            best_track["match_count"] += 1
            matched.add(id(best_track))

            if raw_frame is not None:
                x1, y1, x2, y2 = box
                area = max(0, x2 - x1) * max(0, y2 - y1)
                # Largest-area crop over the track's life, not
                # highest-OCR-confidence -- picking by OCR confidence would
                # systematically exclude exactly the tracks most worth a
                # fallback (zero OCR candidates ever has no confidence
                # signal at all to rank by).
                if area > best_track["best_crop_area"]:
                    best_track["best_crop"] = raw_frame[y1:y2, x1:x2].copy()
                    best_track["best_crop_area"] = area

            plate = det.get("plate_number")
            if not plate:
                continue
            self.total_plate_candidates += 1
            confirmed = best_track["tracker"].add(plate, det["confidence"], det["note"])
            if confirmed and not self._recently_confirmed(confirmed["plate_number"]):
                confirmed_events.append(confirmed)
                self._mark_confirmed(confirmed["plate_number"], confirmed["note"])

        for t in self.tracks:
            if id(t) not in matched:
                t["missed"] += 1

        # Last chance, right before a track gets pruned below: if it never
        # confirmed through normal OCR voting, try the VLM fallback exactly
        # once. Firing only here means this can never touch a track that
        # already confirmed normally (a long clean run like HR98E4959
        # confirms well before MAX_MISSED_FRAMES and never reaches this
        # condition at all), and never double-fires for the same track.
        for t in self.tracks:
            if (
                t["missed"] == self.MAX_MISSED_FRAMES
                and not t["vlm_dispatched"]
                and not t["tracker"].confirmed
                and t["match_count"] >= self.VLM_FALLBACK_MIN_MATCHES
                and t["best_crop"] is not None
            ):
                t["vlm_dispatched"] = True
                self._vlm_pending.append(
                    self._vlm_executor.submit(vlm_fallback.read_plate_vlm, t["best_crop"])
                )

        self.tracks = [t for t in self.tracks if t["missed"] <= self.MAX_MISSED_FRAMES]

        return confirmed_events

    def pending_vlm_futures(self):
        """Read-only access to in-flight VLM fallback calls, for a caller
        that wants to wait on them (e.g. draining before a final summary
        at the end of a finite video) without reaching into a private
        attribute. See pop_ready_vlm_confirmations() to collect results."""
        return list(self._vlm_pending)

    def pop_ready_vlm_confirmations(self):
        """
        Call once per processed frame (after update()). VLM fallback calls
        run in a background thread (see update()'s docstring for why) and
        complete on their own schedule, so their confirmations can't come
        out of update()'s own return value -- this collects any that
        finished since the last call. Returns a list of confirmed-event
        dicts, same shape as update()'s, tagged with
        note == "ok - vlm fallback" so callers can tell them apart from
        normal OCR-confirmed events (e.g. to keep them out of
        send_detection_to_watchlist's default gate).
        """
        ready, still_pending = [], []
        for fut in self._vlm_pending:
            if not fut.done():
                still_pending.append(fut)
                continue
            result = fut.result()
            if result is None:
                continue
            plate, confidence, note = result
            # Same cooldown rule update() uses -- refuse to re-confirm
            # something already close to a recently-confirmed plate (e.g.
            # a different track's normal OCR path confirmed the same
            # vehicle in the meantime).
            if self._recently_confirmed(plate):
                continue
            self._mark_confirmed(plate, note)
            ready.append({"plate_number": plate, "confidence": confidence, "note": note})
        self._vlm_pending = still_pending
        return ready
