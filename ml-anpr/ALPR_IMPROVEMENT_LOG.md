# ALPR Accuracy Improvement Log

Branch: `experiment/anpr-accuracy-improvements` (not merged to `main` —
that decision is left to the repo owner). Baseline compared against:
`main` @ `ae79010` ("checkpoint: working ANPR pipeline before
architecture experiment").

## Context correction (read this first)

The task brief for this experiment described character-level
voting/reconstruction across the confirmation window as "not yet
built." That's out of date — the actual checkpointed baseline on `main`
already has this: `PlateConfirmationTracker` in `detect_plate.py`
implements exactly that (edit-distance + containment clustering,
confidence-weighted per-character voting, a duplicate-alert guard), from
an earlier session. It's real, tested code, not a proposal. This log
does **not** re-implement that — it works from the actual baseline and
targets a different, still-open gap: **static single-frame OCR
accuracy**, which the temporal voting system can't help with (it only
kicks in across multiple frames of the same live plate; the 3 available
ground-truth test images are each a single shot, so voting never
engages on them).

## Ground truth

No documented ground truth existed for `test_images/` — established it
by visually inspecting the plates directly:

| file | ground truth |
|---|---|
| car1.jpg | `MH48AW4023` |
| car2.jpg | `HR20AG3739` |
| car3.jpg | `MH20DV2366` |

All three are valid strict-pattern plates (`LL DD LL DDDD`).

## Baseline (before this branch's changes)

| file | got | exact match | confidence | note |
|---|---|---|---|---|
| car1.jpg | `None` | no | 0 | "Text found, none plate-shaped" |
| car2.jpg | `HR2OAG3739` | no (1 char: `0`→`O`) | 0.93 | fallback tier |
| car3.jpg | `MHZODV2366` | no (2 chars: `2`→`Z`, `0`→`O`) | 0.45 | fallback tier |

**0/3 exact matches.** Ran with `time.time()` timing around
`detect_plate()`, single-image, no video/streaming involved.

## Improvement 1: scope the `.`-rejection to fallback tier only

**Why.** Dumped raw (pre-cleaning) OCR output for all 3 images. car1's
raw OCR read was `'MH,48.AW,4023'` at **0.803 confidence** — a
character-perfect read of the real plate, using dots as visual
separators. It was being discarded before the cleaning/pattern-match
step ever ran, by a blanket `if '.' in text: continue` filter added in
an earlier session specifically to reject GPS-overlay dashcam text
(`"E77.1247,N28.5475"`). That filter is strictly broader than it needs
to be: GPS-style text, after the same `[^A-Z0-9]` cleaning already
applied everywhere else, cannot survive into a full strict-pattern match
(wrong length, wrong character-type layout) — so the `.`-reject only
needs to guard the *looser* fallback tier, not the strict tier where a
full structural match is already strong proof it's a real plate.

**Change.** Moved the `.` check so it only applies to the
`elif ... fallback_candidates.append(...)` branch; strict-pattern
matches are no longer pre-filtered on raw '.' presence.

**Measured result.** car1: `None` → `MH48AW4023` (exact match, conf
0.8, promoted from a total miss to the highest-trust tier).
**0/3 → 1/3 exact matches.**

**Regression check.** Re-verified the GPS-overlay case
(`E77.1247,N28.5475` → cleaned `E771247N285475`) is still correctly
rejected — it's 14 characters and doesn't start with 2 letters, so it
fails the fallback-tier check exactly as before. No change in behavior
for the case this filter was originally added to protect against.

**Verdict: kept.**

## Improvement 2: position-aware confusable-character correction

**Why.** The two remaining errors (car2: `HR2OAG3739` vs real
`HR20AG3739`; car3: `MHZODV2366` vs real `MH20DV2366`) are both a
single/double character swap between visually-similar letter/digit
pairs (`0↔O`, `2↔Z`) landing at a **digit-only position** in the fixed
Indian plate layout (positions 0-1 letters, 2-3 digits, 4-5(ish)
letters, 6-9 digits). This is a well-known, narrow OCR failure mode —
not a detection failure, not a false positive, just glyph ambiguity at
a position where the plate format tells us exactly what character type
*must* be there.

**Change.** Added `_correct_plate_positions()`: for any cleaned OCR
string that's exactly plate-length (9 or 10 chars), check each
position against the expected letter/digit type for that position; if
a wrong-type character is one of the known confusable pairs (`O/0`,
`I/1`, `Z/2`, `S/5`, `B/8`, `G/6`), correct it. The correction is only
**accepted** if the corrected string then fully matches
`INDIAN_PLATE_PATTERN` — so this can't turn arbitrary text into a fake
plate, it can only recover a plate that was one confusable character
away from a full structural match. Wired in as a second check between
the strict-pattern check and the fallback tier, so a corrected match
gets the same high-trust "pattern match" tier as an uncorrected one.

**Measured result.**
- car2: `HR2OAG3739` → `HR20AG3739` (exact match, conf 0.93, promoted
  from fallback tier to pattern-match tier).
- car3: `MHZODV2366` → `MH20DV2366` (exact match, conf 0.45, promoted
  from fallback tier to pattern-match tier).

**3/3 exact matches** (up from 1/3 after improvement 1, 0/3 baseline).

**Regression check.** Replayed the known false-positive strings caught
during earlier sessions (`1008ELECTRIC`, `100ELECTRIC`, `ELIGIBILITY`,
the GPS string, `JOPAACKCCUK0`) directly through
`_correct_plate_positions()` — all correctly return `None` (all wrong
length for a plate). Also replayed the exact reading sequence from an
earlier dashcam-video test session through `PlateConfirmationTracker`
to confirm the temporal voting system still converges on the same
correct plate (`DL52CD0882`) as before — unaffected, since this change
is scoped to single-reading candidate promotion, not the tracker.

**Verdict: kept.**

## Combined result

| file | baseline | after both fixes |
|---|---|---|
| car1.jpg | `None` (miss) | `MH48AW4023` ✅ (conf 0.8) |
| car2.jpg | `HR2OAG3739` ✗ | `HR20AG3739` ✅ (conf 0.93) |
| car3.jpg | `MHZODV2366` ✗ | `MH20DV2366` ✅ (conf 0.45) |
| **Exact match rate** | **0/3** | **3/3** |

Diff size: 46 insertions, 3 deletions in `detect_plate.py`. No new
dependencies. `send_detection_to_watchlist()`'s signature/contract is
untouched.

## Proposed but not attempted: swapping EasyOCR for PaddleOCR

Considered as a third option (per the brief's suggestion) but did not
implement it, for a concrete reason rather than time pressure alone:
**the only test set with ground truth is now at 3/3 exact matches**, so
there's no headroom left to demonstrate PaddleOCR is actually better on
it — a controlled comparison needs cases where the current pipeline
still fails, and none remain in `test_images/`. Swapping OCR engines is
also a heavier, riskier change (new dependency, different API, different
failure modes entirely) than the brief's own "incremental improvements
only" guidance calls for, especially without evidence it's needed.

**Recommendation for follow-up, not done here:** if pursuing this,
first collect more ground-truth test images that specifically fail
under the current pipeline (harder angles, worse lighting, more motion
blur) — *then* a PaddleOCR vs. EasyOCR comparison would have something
real to measure against. Comparing on a saturated 3/3 test set would
prove nothing either way.

## What to review before merging

1. `_correct_plate_positions()`'s confusable-character map (`O/0`,
   `I/1`, `Z/2`, `S/5`, `B/8`, `G/6`) is standard for this kind of OCR
   correction but was only validated against 2 real confusion cases
   (`0/O`, `2/Z`) — the other 4 pairs are untested against real data,
   included on the reasonable assumption they're the same class of
   error, not because they were observed.
2. The `.`-rejection scoping change (improvement 1) is a net widening
   of what the strict-pattern tier accepts — low risk given the strict
   regex is the actual safety net, but worth a second look given it's a
   security-adjacent filter (this is exactly the kind of filter that
   exists to keep dashcam GPS burn-in text out of watchlist alerts).
3. Both fixes were validated against only 3 images total. Real
   dashcam/live footage may surface confusable-character pairs or edge
   cases not represented here.

---

# Session 2 — OCR engine comparison (PaddleOCR vs. EasyOCR)

Continuation of the same experiment branch, same protections
(`send_detection_to_watchlist()` untouched, `main` untouched). Follows
up directly on "Proposed but not attempted" above — the PaddleOCR
comparison was attempted this session, now that the 3/3 baseline gives
a real target to try to beat with harder evidence (raw confidence
margin, not just pass/fail), even though the exact-match rate itself
can't go above 3/3 on this tiny set.

## Experiment 3: PaddleOCR (PP-OCRv6) vs. current EasyOCR pipeline

- **Architecture tested:** same YOLO vehicle detection + crop stage
  (unchanged), swapped only the OCR call — PaddleOCR's `PaddleOCR(...).predict()`
  fed the identical YOLO vehicle-crop images our real pipeline produces
  (saved to disk and fed to PaddleOCR in a completely separate,
  isolated venv — see "Problems found" below for why).
- **Models used:** `paddleocr` 3.7.0 / `paddlepaddle` 3.3.1 (CPU),
  `PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec` (auto-downloaded on
  first run, ~50MB total). Compared against the current pipeline's
  EasyOCR (`easyocr.Reader(['en'], gpu=False)`), unchanged.
- **Dataset:** the same 3 ground-truth images (`test_images/`), fed as
  the exact YOLO vehicle-crop files the real pipeline generates, not
  the raw uncropped photos — this matters, see "Problems found."
- **Conditions tested:** only daytime, clear, well-lit, front/rear
  plate photos — the only conditions any test data in this repo
  currently covers. Night, glare, rain/fog, low-resolution, and extreme
  angle are **not tested by this experiment** (no such footage exists
  locally — see "Next improvement to investigate").
- **OCR accuracy / complete plate accuracy:**

  | file | EasyOCR (current pipeline) | PaddleOCR (raw, no correction) |
  |---|---|---|
  | car1.jpg | `MH,48.AW,4023` conf 0.803 → needs `.`-scoping fix to not be discarded | `MH.48.AW.4023` conf **1.000**, correct immediately |
  | car2.jpg | `HR2OAG3739` conf 0.93 → needs position-correction fix (`O`→`0`) | `HR20AG3739` conf **0.999**, correct immediately |
  | car3.jpg | `MHZODV2366` conf 0.45 → needs position-correction fix (`Z`→`2`, `O`→`0`) | `MH20DV2366` conf **0.999**, correct immediately |

  PaddleOCR: **3/3 exact matches on the raw model output, zero
  custom correction logic needed**, at 0.999–1.000 confidence.
  Our current pipeline needs both fixes from Experiments 1-2 to reach
  the same 3/3, and even then tops out at 0.45–0.93 confidence — a
  real, measurable gap, not a marginal one.
- **Detection accuracy:** not independently isolated in this
  experiment — both engines were tested on the same YOLO-provided crop,
  so this experiment measures OCR/recognition quality only, not
  plate-region detection quality. (Plate-region detection itself is
  still the coarse "whole vehicle crop + heuristic lower-band region"
  approach from Experiment 2's session — a dedicated plate detector,
  e.g. from the Roboflow "Indian Number Plates" dataset found during
  research, is a separate untested lever, blocked on needing an API
  key this environment doesn't have.)
- **Night / low-quality CCTV performance:** **not tested** — no
  night/low-light/motion-blur/rain footage exists in this repo to test
  against. This is a real gap in what this experiment can claim, not an
  oversight being glossed over.
- **FPS/latency:** PaddleOCR: 0.45–1.11s per image (single OCR pass,
  CPU). Current pipeline: EasyOCR needs *two* OCR passes per frame
  (whole-crop + region-crop, added in an earlier session specifically
  to compensate for weak signal on small crops) at roughly similar
  per-pass cost. If PaddleOCR's accuracy holds up on harder data, it
  may also let us drop back to a single OCR pass — untested, flagged as
  a follow-up.

### Problems found

**`pip install paddleocr` broke the working pipeline.** Installing
`paddleocr`/`paddlepaddle` into the real `ml-anpr/venv` pulled in
`opencv-contrib-python` as a transitive dependency, which silently
shadowed the existing `opencv-python==5.0.0.93` (`cv2.__version__`
changed from `5.0.0` to `4.10.0` with no error or warning). This
**directly caused a real regression**: the current pipeline's
benchmark dropped from 3/3 to 2/3 (car3 started misreading
`MH20DY2366` instead of `MH20DV2366` — a different OpenCV build's
resize/decode behavior changed what EasyOCR saw). Caught immediately by
re-running the existing benchmark after install, before doing anything
else. Fixed by uninstalling `paddleocr`/`paddlepaddle`/`paddlex`/
`opencv-contrib-python` and force-reinstalling `opencv-python==5.0.0.93`
— re-verified 3/3 restored before continuing. All further PaddleOCR
testing was done in a completely separate, throwaway venv
(`/tmp/.../paddleocr_test_venv`, outside the repo) that never touches
`ml-anpr/venv`, specifically so this can't happen again.

**Lesson for whoever integrates this for real:** installing
`paddleocr` alongside the existing `opencv-python` needs the opencv
pin handled explicitly (e.g. install paddleocr first, then
`pip install --force-reinstall opencv-python==<pinned version>`, and
add that constraint to `requirements.txt`) — don't just `pip install
paddleocr` into the real environment and assume it's additive.

### Verdict: promising, evidence is real — **not integrated into
`detect_plate.py` this session, left for the next iteration**

This is a genuine, measured improvement over the current OCR engine on
every image tested, by a wide confidence margin, with no correction
hacks required. That's a strong case for switching. It is **not yet
integrated** into the actual pipeline, deliberately: the dependency
conflict above is a real signal to move carefully rather than fast
here, and a full swap needs — beyond just replacing the OCR call —
re-tuning the two-tier confidence floors (currently 0.25/0.4, tuned
around EasyOCR's weaker confidence range; PaddleOCR's ~0.999 range
suggests these floors and the whole two-tier design might need
rethinking), re-running the full dashcam-video regression suite from
Experiment 2's session (temporal voting, false-positive checks), and
confirming `send_detection_to_watchlist()`'s contract stays untouched
through the swap. That's real integration work deserving its own
careful pass, not something to bolt on in the last few minutes of this
one.

## Next improvement to investigate

1. **Integrate PaddleOCR into `detect_plate.py` properly** (highest
   priority given the evidence above): fix the opencv pin in
   `requirements.txt`, swap the OCR call, re-tune confidence floors for
   PaddleOCR's actual confidence distribution, re-run the full video
   regression suite, confirm no watchlist-contract changes.
2. **Get real night/low-light/motion-blur/rain test data.** Every
   experiment in this log — this one and Experiments 1-2 — is validated
   against 3 daytime, clear, well-lit photos. The system requirements
   this whole effort is scoped against explicitly include night, glare,
   rain/fog, and low resolution, and **none of it has been tested
   against any of those conditions**, because no such footage exists in
   this repo. This is the single biggest gap between what's been proven
   here and what the actual requirements ask for.
3. Investigate a dedicated plate-region detector (Roboflow's "Indian
   Number Plates" dataset, found during research) as a replacement for
   the current heuristic lower-band crop — blocked on needing a
   Roboflow API key not available in this environment.
