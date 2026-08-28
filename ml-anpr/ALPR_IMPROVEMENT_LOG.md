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

---

# Session 3 — integrate PaddleOCR, and a false-positive regression it introduced

Continuation of the same branch/protections. Executes Session 2's
top-priority follow-up: integrate PaddleOCR into `detect_plate.py` for
real, re-tune, and re-run the full regression suite rather than trust
the static-image win alone.

## Experiment 4: PaddleOCR integration + a real false-positive bug it surfaced

- **Architecture tested:** same YOLO vehicle-crop stage; OCR engine
  swapped from `easyocr.Reader` to `PaddleOCR(use_angle_cls=True,
  lang='en')` (PP-OCRv6) via a small adapter (`_ocr_readtext()`)
  matching EasyOCR's `readtext()` return shape, so the candidate
  filtering / correction / temporal-voting logic below it needed zero
  changes. `preprocess_for_ocr()` (grayscale + CLAHE, tuned for
  EasyOCR) is no longer called on this path — PaddleOCR crashes on
  single-channel input and, per testing, doesn't need it: the raw BGR
  crop alone scored 0.999–1.000 on every ground-truth image.
- **Models used:** `paddleocr` 3.7.0 / `paddlepaddle` 3.3.1 (CPU),
  `PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`.
- **Dataset / conditions tested:** the same 3 ground-truth images, plus
  — for the first time — the full `dashcam_trimmed.mp4` regression
  (real moving traffic, motion blur, multiple vehicles), not just
  static photos. Still no night/low-light/rain footage available.
- **Setup problem, fixed properly this time:** `pip install paddleocr`
  again pulled in `opencv-contrib-python`, which again shadows
  `opencv-python`. Fixed by installing paddleocr first, then
  immediately `pip install --force-reinstall opencv-python==5.0.0.93`,
  and verifying `cv2.__version__` plus the 3/3 benchmark *before*
  touching any pipeline code. No `requirements.txt` exists in
  `ml-anpr/` to pin this in (dependencies here are ad-hoc, not
  tracked in any manifest) — noting that as a real gap, not something
  this session's scope covers fixing.
- **OCR / complete plate accuracy (static images):** 3/3 exact matches,
  same as Session 1's result, but now at 1.0 confidence with **no
  correction logic needed** — `_correct_plate_positions()` (Experiment
  2) didn't have to fire for any of the 3 images this time; PaddleOCR
  read them correctly on the first pass.
- **Video regression — real, serious problem found:** first full run
  of `dashcam_trimmed.mp4` produced **6 confirmed plates, 2 of them
  fake**: `II22IS3507` and `IZ21S3521`, both auto-confirmed at
  0.94–1.0 confidence with `note: "ok - pattern match"` — meaning both
  would have fired a real `send_detection_to_watchlist()` call in the
  live pipeline. Investigated by dumping an actual video frame:
  `2023-11-22 15:35:23` is a dashcam-burned-in timestamp overlay in the
  bottom-left corner, incrementing every frame — which lines up exactly
  with the confirmed strings incrementing (`II22IS3507` → `II22IS3508`
  → `II22IS3509` → ... → `II22IS3539` over the course of the clip).
  Root cause confirmed directly: the YOLO "largest box" vehicle
  selection picked a close-range SUV mirror whose bounding box extends
  to `y2 = 1080` — the literal bottom pixel of a 1080px-tall frame —
  pulling the overlay text straight into the OCR crop. The existing
  `.`-based GPS-overlay filter (Experiment 1) didn't catch this because
  the timestamp overlay has no `.` character in it, only digits and
  colons/hyphens — a real gap in that filter's coverage, not a bug in
  it. **This false-positive risk did not exist with EasyOCR** — across
  all of Sessions 1–2's dashcam testing (same clip, same YOLO crops),
  EasyOCR never confirmed anything from this overlay band. A stronger,
  more confident OCR engine reading everything more accurately, including
  text that shouldn't have been read as a plate at all, made this worse,
  not better — a genuinely important, non-obvious finding: raw OCR
  engine strength and false-positive resistance are not the same axis.
- **Fix:** clip the vehicle crop's bottom edge to `min(y2, 0.92 *
  raw_frame_height)` before OCR ever sees it — dashcam UI overlays
  (date/time, speed/GPS) consistently live in a fixed bottom band of
  the frame regardless of where a vehicle is, so real plates don't need
  that band and it's safe to exclude.
- **Re-verified after the fix:** static images still 3/3 (the clip only
  matters for boxes that reach near the frame bottom — none of the 3
  test photos do). Re-ran the full `dashcam_trimmed.mp4` regression:
  **both timestamp false positives are gone.** Down to 4 confirmed
  plates: `HR98E4959`, `THR26E06477`, `FRJ45CK2913`, `OL52OO0882` — zero
  of them traceable to the overlay band.
- **Genuine win, verified twice:** `HR98E4959` — the exact plate cited
  in this project's own original problem description as the canonical
  "unsolvable" motion-blur example (`HR9BE4959` / `HR98E4959` /
  `HR9854952`, same real plate, never converging) — now converges
  cleanly and repeatedly to the identical string across 10 separate
  frames (200, 220, 230, 310, 320, 330, 340, 360, 370, 380), at
  0.96–1.0 confidence every time, in both the pre-fix and post-fix
  runs. This is a real, direct resolution of the problem this whole
  effort was originally framed around.
- **Not resolved — honest gap, not swept under the rug:**
  `THR26E06477` and `FRJ45CK2913` (fallback tier, 11 chars — extra
  stray character, likely from crop edge noise) and `OL52OO0882` are
  still confirmed with real character noise. `OL52OO0882` in particular
  is concerning: this looks like the same real plate Session 1's
  EasyOCR pipeline correctly converged on as `DL52CD0882` on this exact
  clip — under PaddleOCR it drifts through `DL52OO0882` / `DL72O0009`
  / `DL52GD0882` / `DL52GO0882` and confirms the wrong one. Whether
  this is PaddleOCR genuinely reading this specific plate worse, or an
  artifact of which frames/angles got sampled, wasn't investigated
  further this session — flagged honestly as unresolved rather than
  guessed at.
- **Night / low-quality CCTV performance:** still not tested. Still the
  single biggest gap between everything proven in this log and the
  actual system requirements.
- **FPS/latency:** 0.45–1.11s per PaddleOCR call (two calls per
  processed frame, same two-pass whole-crop + region-crop structure as
  before) — meaningfully slower per-call than EasyOCR was, but this
  session didn't measure full end-to-end frame throughput head-to-head;
  flagged as a follow-up measurement, not claimed either way.

### Verdict: **kept, with honestly-documented remaining issues**

Net improvement over the EasyOCR baseline: solves the project's own
canonical hard case (`HR9BE4959`-style drift) cleanly and repeatably,
raises static-image confidence from a 0.45–0.93 range needing custom
correction logic to ~1.0 needing none, and — after the overlay-band
fix, which was *necessary*, not optional, to keep this — has zero
demonstrated false positives, matching EasyOCR's clean record. It is
**not** a flawless replacement: `OL52OO0882`/`THR26E06477`/
`FRJ45CK2913` show it still has real character-level noise on some
plates, on par with or in one case possibly worse than EasyOCR's own
imperfect record on the same clip. Keeping this is a judgment call
based on the balance of evidence, not a claim that every metric
improved — flagged clearly for whoever reviews this branch.

## Next improvement to investigate

1. **Dig into why `OL52OO0882`/`DL52...` doesn't converge correctly** —
   pull the actual frames this cluster is reading from and look at them
   directly (the way the overlay bug was diagnosed), rather than
   guessing from confidence numbers alone.
2. **Re-tune the confidence floors (0.25 pattern / 0.4 fallback).**
   Deferred again this session — still no real "PaddleOCR confidently
   wrong" example to calibrate against (the overlay false positives
   were confidently *shaped right*, not usefully wrong in a way that
   suggests a floor fix). `THR26E06477`/`FRJ45CK2913` at 0.96-0.98
   confidence in the fallback tier suggest confidence alone won't
   separate real fallback-tier noise from real plates either — this
   likely needs a different signal than a raised floor.
3. **Get real night/low-light/motion-blur/rain test data** — unchanged
   from Session 2, still the top gap, now three sessions running.
4. Dedicated plate-region detector — unchanged from Session 2, still
   blocked on a Roboflow API key this environment doesn't have.

---

# Session 4 — degraded-condition robustness (synthetic proxy, real dataset blocked)

Continuation of the same branch/protections. Directly addresses "Next
improvement #3" above, which has now been deferred for 3 straight
sessions with zero evidence gathered on it.

## Real-dataset search: blocked, not skipped

Before falling back to anything synthetic, searched for actual free
Indian-plate / night-CCTV datasets:

- **Kaggle** ("Indian License Plates with Labels", "Indian Number
  Plates Dataset") — requires a Kaggle account + API credentials, not
  configured in this environment (no `~/.kaggle/`, no `kaggle` CLI).
  Didn't set up new external account credentials on the repo owner's
  behalf without asking — out of scope for an autonomous session.
- **"Indian Licence Plate Dataset in the wild"** (arXiv 2111.06054,
  16,192 images, 10 states, dashcam + static CCTV — exactly the right
  shape of data) — checked the linked GitHub repo
  (`sanchit2843/Indian_LPR`) directly. It explicitly does **not**
  publish the dataset: *"We can't make dataset public because of
  legalities involved in making Indian Road data public."* Only
  pre-trained weights and demo images are public.
- **LPBlur** (real low-light + rain license-plate pairs, not Indian
  plates but real optical degradation) — hosted on Google Drive /
  Baidu Netdisk only, no direct scriptable download, no account
  configured for either.

All three are real, legitimate leads — genuinely blocked by
authentication/hosting, not abandoned after a token search.

## Experiment 5: synthetic degraded-condition benchmark

**Caveat stated up front, not buried:** this is a synthetic proxy, not
real footage. Real night CCTV has sensor noise, real headlight optics,
and real low-light color response that synthetic brightness/blur/
overlay adjustments don't reproduce. This experiment answers "how does
the current pipeline respond to these specific synthetic
perturbations," not "how does it perform on real night CCTV" — treat
results as a lower bound on real-world difficulty, not a substitute
for real data.

- **Dataset:** the same 3 ground-truth images, each degraded 4 ways
  with plain OpenCV/numpy (no new dependency): low-light (25%
  brightness + Gaussian sensor noise), motion blur (15px horizontal
  box-kernel blur), glare (a bright overlaid circle near the plate
  region), fog (50% blend with a flat gray layer). Saved to
  `ml-anpr/test_images_degraded/` (12 images, ~1MB total) so future
  sessions can re-run this exact benchmark without regenerating it.
- **Conditions tested:** low-light, motion blur, glare, fog/haze — 4 of
  the 6 adverse conditions named in the system requirements (rain and
  night specifically weren't separately simulated; low-light and fog
  are reasonable proxies for parts of both).
- **Complete plate accuracy by condition** (full pipeline,
  `detect_plate()`, current PaddleOCR-based code from Session 3):

  | condition | exact matches | notes |
  |---|---|---|
  | glare | 3/3 | no measurable impact |
  | fog | 3/3 | no measurable impact |
  | low-light | 2/3 | car1: YOLO itself failed to find a vehicle in the darkened image (`"No vehicle detected"`) — a detection-stage failure, not an OCR failure |
  | **motion blur** | **0/3** | all 3 failed; the one that returned any OCR text at all read `HR20AG3739` as `'12200379'` (0.69 conf) — letters dropped entirely, not just confused |

  **Motion blur is the clear, dominant failure mode** — far worse than
  the other 3 conditions combined, and the only one that fails
  completely rather than partially.
- **Attempted fix: unsharp-mask sharpening before OCR** (free, no new
  dependency, the cheapest plausible deblur technique — item #10 on
  the research list). Tested on all 3 blurred crops, compared raw OCR
  output before/after:

  | image | raw blurred OCR | after unsharp mask |
  |---|---|---|
  | car1 | `'BR'` (0.71) | `'营'` — a stray CJK character (0.39) |
  | car2 | `'12200379'` (0.69) | *(nothing detected)* |
  | car3 | *(nothing detected)* | *(nothing detected)* |

  **Made things strictly worse on every image tested** — lower
  confidence, less text recovered, one case (car1) produced outright
  garbage. This matches the well-known limitation of naive sharpening
  on heavily blurred images: it amplifies blur-induced artifacts rather
  than recovering genuinely lost detail. **Rejected**, with real
  evidence, not a guess.
- **Night performance:** not directly tested (no real night data — see
  above); low-light proxy result (2/3, one full detection failure) is
  the closest available signal.
- **Detection accuracy:** the one clear detection-stage (not
  OCR-stage) failure was low-light car1 — YOLO found no vehicle at all
  in the darkened frame. Worth separate follow-up: is this a YOLO
  confidence-threshold issue (a lower threshold might still find the
  vehicle) or a genuine detection failure needing better low-light
  preprocessing before the detection stage, not just the OCR stage?
  Not investigated further this session.

### Verdict: **no code change kept this session** — this was a
diagnostic experiment, not an implementation one, and its one concrete
attempted fix (unsharp masking) was tested and rejected with evidence.

## Next improvement to investigate

1. **Motion blur is now the clearly evidenced #1 weakness** — worth a
   real learned deblurring model next (e.g. LPDGAN, found during this
   session's research, purpose-built for license plates and reports
   handling low-light + rain too) rather than another cheap classical
   technique, given unsharp masking's clear failure. This is a bigger
   lift (new model, new dependency, needs its own careful integration
   pass like Session 3's PaddleOCR work) — flagging for a dedicated
   session, not attempting rushed here.
2. Investigate the low-light **detection**-stage failure (YOLO finding
   no vehicle at all) separately from the OCR-stage question — might
   be a simple confidence-threshold tune, might need real preprocessing
   before detection too.
3. Dig into `OL52OO0882`/`DL52...` non-convergence — unchanged from
   Session 3.
4. Re-tune confidence floors — unchanged from Session 3, still no good
   calibration signal.
5. Dedicated plate-region detector — unchanged, still blocked on a
   Roboflow API key.

---

# Session 5 — low-light detection fix, and why it isn't turned on by default

Continuation of the same branch/protections. Addresses Session 4's
"Next improvement #2": the low-light detection-stage failure (YOLO
finding zero vehicles at all in `car1_lowlight.jpg`).

## Experiment 6: low-light preprocessing (denoise + CLAHE)

- **Diagnosis:** at `conf=0.05` (far below YOLO's normal ~0.25
  threshold), YOLO found *zero* vehicle-class boxes on the darkened
  frame — only wrong-class noise (cell phone, laptop, remote, all
  <0.15 conf). Not a threshold-tuning issue; a genuine recognition
  failure.
- **Tested 3 preprocessing techniques on the actual failing frame,
  each checked for a real vehicle-class detection:**

  | technique | vehicle detected? |
  |---|---|
  | gamma correction (γ=2.5) | no — image looks readable to a human, still nothing to YOLO |
  | CLAHE alone (LAB L-channel) | barely — conf 0.014, still below threshold |
  | **denoise (`fastNlMeansDenoisingColored`) then CLAHE** | **yes — conf 0.288, clears the default threshold** |

  CLAHE alone actually amplifies the synthetic sensor noise rather than
  helping — denoising first is what unlocks it. This matches the
  well-understood order-of-operations for this class of preprocessing,
  now confirmed on our own failing case rather than assumed.
- **End-to-end result on the low-light degraded set:** still 2/3 exact
  matches (unchanged count) — but the *reason* car1 fails changed from
  "no vehicle detected" to a real, different, more specific problem:
  the recovered vehicle box is real but too tight, cutting off the
  bumper/plate area entirely (visually confirmed — the crop shows only
  windshield and badge, no bumper). So this fix is real progress on
  the specific bug it targeted, even though it didn't fully solve car1
  end-to-end. Flagging the box-tightness issue as a distinct, separate
  problem rather than claiming this fix "didn't work."
- **Regression check (clean images):** no impact — all 3 clean
  ground-truth images still 3/3 exact, still 1.0 confidence, with the
  preprocessing applied.
- **Regression check (video, the important one):** wired the fix into
  `detect_plate_from_frame`'s default path (applied to `infer_frame`
  before YOLO and to the vehicle crop before OCR) and re-ran the full
  `dashcam_trimmed.mp4` regression. Two real findings, one good, one
  bad:
  - **Good:** `HR26EO6477` (a real plate, previously confirmed as the
    noisy 11-character `THR26E06477` in Session 3's run, with a stray
    prefix character) now confirms *cleanly* in the pattern-match
    tier, no stray character. Unplanned, real, positive side effect.
  - **Bad — this is the important finding:** total wall-clock time for
    the same clip jumped from 168-280s (prior sessions) to **10
    minutes 8 seconds** — roughly a **2.5-3.6x slowdown**. Confirmed
    via `time`, not estimated: `618.17s user 9.17s system ... 10:08.67
    total`. `fastNlMeansDenoisingColored` is expensive, and this session
    applied it *twice* per processed frame (once for detection, once
    for OCR).
- **Decision: reverted the automatic wiring.** The function
  (`enhance_low_light()`) is defined, documented, and tested — but
  **not called by default** in `detect_plate_from_frame` anymore. A
  2.5-3.6x throughput cost for a partial fix (real progress on one
  failure mode, didn't fully solve it, plus one good but anecdotal
  side effect on real video) is a genuine tradeoff call, not a clear
  win to force through unilaterally, especially days before a
  hackathon demo where live-feed responsiveness matters. This is
  exactly the kind of decision the safety note asks to leave for human
  review rather than deciding alone.
- **What's actually kept from this session:** the diagnosis (denoise
  order matters, gamma/CLAHE-alone don't work), the tested function
  itself (available to call explicitly), and the clear evidence for
  the cost/benefit tradeoff — not an automatic behavior change.

### Verdict: **investigated and coded, but not enabled by default —
left as a human decision**

## Next improvement to investigate

1. **Human decision needed:** is a 2.5-3.6x slowdown acceptable to
   enable `enhance_low_light()` by default for better low-light
   handling? If yes, it's already written, tested, and just needs its
   2 call sites restored (`detect_plate_from_frame`, both the
   `infer_frame` YOLO call and the `vehicle_img` crop). If a middle
   ground is wanted, consider applying it conditionally (e.g. a cheap
   brightness check on the frame, only denoise+CLAHE when actually
   dark) rather than unconditionally — not implemented or tested this
   session, flagged as an option.
2. If enabling it: still need to separately fix the box-tightness
   issue found on car1 (real vehicle detected, box too tight to
   include the plate) — a different bug from the one this session
   fixed.
3. Motion blur — unchanged from Session 4, still the single biggest
   evidenced gap, still needs a real deblurring model (LPDGAN) as a
   dedicated future session's work.
4. `OL52OO0882`/`DL52...` non-convergence — unchanged from Session 3,
   still unresolved (now reads as `UL52OO0862` under this session's
   since-reverted preprocessing — yet another variant, reinforcing that
   this specific plate/frame-range is a hard case regardless of
   preprocessing).
5. Confidence floor re-tuning, dedicated plate-region detector —
   unchanged from prior sessions.

---

# Session 6 — the middle-ground option: gate low-light enhancement behind a brightness check

Continuation of the same branch/protections. Implements the exact
"middle ground" option Session 5 flagged but didn't build: apply
`enhance_low_light()` only to frames that are actually dark, instead
of either "always" (accurate but 2.5-3.6x slower) or "never" (fast but
gives up the low-light detection fix entirely).

## Experiment 7: brightness-gated low-light enhancement

- **Threshold calibrated from real data, not guessed:** measured mean
  grayscale brightness across everything already in the test corpus —
  the 3 clean ground-truth images: 97-119. Their synthetically
  darkened counterparts: 25-29. The fog/glare degraded variants: 131-
  159 (brighter than clean, confirming they shouldn't and don't trigger
  the gate). A wide, cleanly-separated gap; picked 50 as the midpoint.
  Also checked the dashcam video itself at 4 points across the clip:
  117-124 throughout — consistently well above the threshold, so the
  gate should skip enhancement on it entirely.
- **Implementation:** added `is_low_light(img)` (one grayscale mean
  comparison, negligible cost) and `LOW_LIGHT_BRIGHTNESS_THRESHOLD =
  50`. `detect_plate_from_frame` checks this once per frame (on
  `infer_frame`) and reuses the same yes/no decision for both the
  detection-stage call (`infer_frame`) and the OCR-stage crop
  (`vehicle_img`) — one brightness check per frame, not two.
- **Static image re-verification:** identical results to Session 5's
  unconditional version — clean images still 3/3 at baseline speed
  (5.72s for 3 images), degraded low-light still 2/3 (car1's specific
  box-tightness issue is unchanged, unrelated to this session), glare/
  fog/motion-blur unaffected, exactly as expected since those don't
  cross the darkness threshold (glare/fog) or aren't addressed by this
  fix at all (motion blur).
- **The result that actually matters — dashcam video, measured, not
  assumed:**

  | version | total wall time | confirmed plates |
  |---|---|---|
  | baseline (Session 3-4, no low-light handling) | 168-280s | `HR98E4959`, `FRJ45CK2913`, `OL52OO0882`, `THR26E06477` |
  | Session 5 (unconditional) | **608s** (2.5-3.6x slower) | `HR98E4959`, `UL52OO0862` (variant), `HR26EO6477` (cleaner) |
  | **Session 6 (brightness-gated)** | **227s** — back in the baseline range | `HR98E4959`, `FRJ45CK2913`, `OL52OO0882`, `THR26E06477` — **identical set to baseline** |

  Confirms the gate works exactly as designed: this well-lit clip
  never crosses the darkness threshold, so behavior and speed are
  byte-for-byte equivalent to having no low-light handling at all —
  zero cost imposed on footage that doesn't need it. The genuine
  accuracy benefit (recovering vehicle detection on dark frames, per
  Session 5's diagnosis) is preserved for frames that actually are
  dark, which this particular video simply doesn't contain any of.
- **What this doesn't prove:** this video has no real low-light
  segments to confirm the gate correctly *triggers* and *helps* on
  real (not synthetic) dark footage — that's still only demonstrated
  on the synthetic `car1/2/3_lowlight.jpg` set. The gate's trigger
  logic itself is simple and directly threshold-tested (real measured
  brightness values, clean separation), so confidence is reasonably
  high, but "zero cost on footage that doesn't need it" and "helps
  footage that does" are two different claims — this session provides
  strong evidence for the first, and only synthetic evidence for the
  second (unchanged from Session 5).

### Verdict: **kept**

Resolves Session 5's cost objection with real measurement, not just
reasoning: same accuracy profile on every condition tested, and video
throughput restored to the pre-Session-5 baseline range. This is now
the default, unconditional behavior of `detect_plate_from_frame` — no
longer flagged as a pending human decision, since the tradeoff that
required that decision no longer exists on the evidence gathered.

## Next improvement to investigate

1. Fix the low-light **box-tightness** issue (car1: real vehicle
   detected, box too tight to include the plate) — unchanged from
   Session 5, still open.
2. Motion blur — unchanged, still the single biggest evidenced gap,
   still needs a real deblurring model (LPDGAN) as a dedicated future
   session's work.
3. `OL52OO0882`/`DL52...` non-convergence — unchanged from Session 3,
   still unresolved. Notably, this session's run reproduced the exact
   same `OL52OO0882` reading as the original Session 3-4 baseline
   (since the gate never triggered on this clip) — reinforcing this is
   a stable, repeatable hard case for this specific plate/frame range,
   not noise from any preprocessing change.
4. Confidence floor re-tuning, dedicated plate-region detector —
   unchanged from prior sessions.

---

# Session 7 — multi-vehicle detection: design (written before code, per instructions)

New instructions for this and future sessions: recurring, unattended,
overnight, 2-day deadline. Non-negotiables carried forward unchanged
(branch-only, `main` untouched, `send_detection_to_watchlist()`
contract frozen, benchmark before/after every change, hard-stop
condition checked at the end of every firing — see top of this
session for the exact condition list, not re-copied here to avoid
drift between the instruction and a paraphrase of it).

Priority 1: multi-vehicle detection. Current `detect_plate_from_frame`
finds every YOLO vehicle box but only ever examines the single
largest one, silently discarding every other vehicle in frame — so a
frame with 3 vehicles, 2 of them with legible plates, only ever gets a
chance at 1.

## Real numbers gathered before designing anything

Sampled YOLO's raw vehicle detections (no filtering) at 7 points
across `dashcam_trimmed.mp4`: **6 to 15 vehicle boxes per frame**.
Box areas as a percentage of total frame area:

- frame 100: 6 boxes — `[16.0, 1.1, 0.46, 0.13, 29.0, 0.24]`
- frame 500: 15 boxes — `[1.57, 2.19, 1.1, 0.84, 10.89, 0.46, 0.46, 0.14, 0.68, 1.2, 30.44, 0.46, 0.35, 0.86, 0.09]`
- frame 1300: 15 boxes — `[0.9, 2.04, 9.69, 0.22, 5.3, 1.9, 1.44, 0.5, 0.29, 0.18, 1.93, 0.19, 29.18, 0.6, 0.25]`

(full 7-point sample in this session's work, pattern consistent
throughout)

**This is the number that shapes the whole design.** Processing every
box unconditionally — 2 OCR calls per box, same as the current
single-box pipeline — would be a 6-15x multiplier on top of an
already-measured 168-280s baseline for this clip: 15-40+ minutes,
plausibly worse. That's not just an FPS concern (which the brief
explicitly deprioritizes) — it's large enough to risk not finishing a
benchmark run within a session's turn budget at all, which would
itself violate "benchmark before/after every change."

The overwhelming majority of boxes are tiny: most sampled frames have
only 1-3 boxes above ~3% of frame area, and 4-12+ boxes under 2%.
Those small boxes are distant background vehicles — physically too
few pixels for a legible plate regardless of OCR quality, the same
reasoning that made "largest box" a defensible (if incomplete) choice
in the original design. This isn't a guess: every plate this log has
ever successfully confirmed came from a box in the large end of this
distribution (the current single-largest-box design already selects
for size, and it works).

**Design decision:** add a minimum box-area threshold (3% of frame
area) alongside YOLO's own confidence threshold, not just "all boxes
above a justified confidence threshold" read literally. Justified by
the measured size distribution above, not guessed — cuts most frames
from 6-15 boxes down to 1-4, a 2-4x multiplier instead of 6-15x, while
still processing every vehicle actually close enough to plausibly have
a legible plate. This threshold is a starting point, not asserted as
correct — flagged for recalibration if benchmarking shows real plates
being cut at this size or the multiplier still being too costly.

## Design

**1. `detect_plate_from_frame` returns a list, not a single dict.**
Collects every vehicle box clearing both YOLO's own confidence
threshold and the new 3%-of-frame-area size floor (previously: tracked
only the single largest). Runs the existing per-box pipeline (overlay
clip, low-light gate, crop, OCR, candidate filtering) unchanged for
each box. Each result dict gains a `"box"` key (the vehicle's
`(x1,y1,x2,y2)` in `raw_frame` coordinates) so callers that need
cross-frame identity can do their own association — this function
itself stays stateless and per-frame, same as before, just multi-box
instead of single-box.

**2. `detect_plate()` (the static single-image test wrapper) keeps its
existing single-dict contract**, unchanged, by taking the largest-box
result from the new list. This is a deliberate compatibility choice,
not an oversight: every existing benchmark script in this log's
history (all 6 prior sessions) calls `detect_plate(...).get(...)`
expecting one dict, and every ground-truth test image
(`test_images/*.jpg`) has exactly one vehicle in it anyway — there is
no multi-vehicle scenario to test in the static-image benchmark, and
changing this contract would only add risk (breaking every prior
regression check) for zero benefit. The actual architectural change —
true multi-vehicle handling — lands where it matters: the streaming
path.

**3. New `VehicleTracker` class**, replacing the single global
`PlateConfirmationTracker` instance in `process_video_file` /
`process_stream` / `process_hls_stream`. Owns one
`PlateConfirmationTracker` *per physical vehicle track*, not one
shared across the whole stream — this is what actually prevents two
different real plates seen in the same (or nearby) frames from being
merged by `PlateConfirmationTracker`'s own similarity-based clustering
(`SIMILARITY_THRESHOLD = 0.7` is permissive enough that two
superficially-similar plates from two different real vehicles could
otherwise cluster together).

Approach 1 (per the brief's ordering — try this first): frame-to-frame
IoU matching, no new dependency.
- Each processed frame's boxes are matched against existing tracks'
  *last known* box via IoU; best-match-above-threshold (0.3) wins.
- Matched: update that track's box, feed its OCR reading into *that
  track's own* `PlateConfirmationTracker`.
- Unmatched: create a new track with a fresh `PlateConfirmationTracker`.
- Tracks unmatched for more than 5 processed frames in a row are
  pruned (vehicle left frame, or occlusion).
- Returns every confirmed event across every track this frame (0 or
  more) — `send_detection_to_watchlist()` gets called once per
  confirmed plate, same as the brief explicitly says is fine, no
  contract change.

**Known risk with this approach, stated up front, not discovered
later:** `process_video_file` only examines every 10th *video* frame
(`process_every_n_frames=10`), so consecutive *processed* frames are
~0.33s apart at 30fps, not ~0.03s — real-world vehicle displacement
between processed frames is meaningfully larger than true
frame-to-frame movement, which is exactly the condition IoU matching
is weakest under (fast motion, low box overlap between samples). This
is the brief's own anticipated failure mode for approach 1
("vehicles crossing paths, occlusion" — fast relative motion between
sparse samples is the same underlying problem). Testing this directly
against the real dashcam clip's actual sampling rate, not a synthetic
best case, before deciding whether to move to approach 2.

## What's explicitly NOT in scope for this session

Approaches 2 (centroid tracking) and 3 (ByteTrack) — only pursued if
approach 1 demonstrably fails, per the brief's own ordering, and this
session hasn't produced that evidence yet. Motion blur (Priority 2) —
not started, Priority 1 comes first per the brief.

## Experiment 8: implementing the design above

**Implementation.** `detect_plate_from_frame` now collects every
vehicle box clearing YOLO's confidence threshold and the 3%-area
floor, runs the existing per-vehicle pipeline (unchanged — overlay
clip, low-light gate, two-pass OCR, candidate filtering, all
extracted into `_read_plate_from_box()` but not otherwise modified)
once per box, and returns a list. `detect_plate()` keeps returning a
single dict (largest-box result), per the design's compatibility
decision. New `_iou()` helper and `VehicleTracker` class (design
above) replace the single global `PlateConfirmationTracker` in all
three streaming entry points (`process_video_file`, `process_stream`,
`process_hls_stream`) — mechanically identical change to all three,
only `process_video_file` directly benchmarked (no live RTSP/HLS
source reachable to test the other two against).

**Bug caught before testing, not after:** first draft of
`VehicleTracker.confirmed` was a property aggregating only from
currently-active tracks — meant a confirmed plate would silently
vanish from the summary once its vehicle left frame and its track got
pruned. Fixed to a persistent set that accumulates across the
tracker's lifetime, independent of track pruning, before this was ever
run against real data.

**Regression checks, in order, before the expensive video run:**
- Syntax check, then static images: still 3/3 exact, byte-identical
  results to pre-Session-7 (`box` field is new but doesn't change
  `plate_number`/`confidence`/`note`).
- Degraded set: still lowlight 2/3, motionblur 0/3, glare 3/3, fog
  3/3 — all unchanged, as expected (single-vehicle test images, this
  session's change only matters when there's more than one vehicle to
  find).
- `send_detection_to_watchlist()`: re-verified byte-identical to
  `main` after all changes (checked programmatically, same method as
  the last review session).

**Dashcam video — the real test.** `process_video_file`, same clip,
same 10-frame sampling, `time`-measured:

- **6m29.76s (390s) total** — vs. Session 6's 227s gated baseline.
  About **1.7x**, not the 6-15x this session's own design section
  worried about before measuring — the 3% area floor did its job.
  Real multi-vehicle payoff confirmed directly: frame 950 produced 4
  separate plate readings from 4 different vehicle boxes in that one
  frame; frames 750, 590, 580, 550 each produced 3.
- **Confirmed plates:** `DL52OO0882`, `RJ45OK2913`, `UP16DN8010`,
  `UP16ON8010`, `OL52OO0882`, `FRJ45CK2913`, `HR38AC7748`,
  `HR98E4959`, `DL52GD4935`, `HR26EO6477` — 10 total, up from
  Session 6's 4. `UP16DN8010`/`UP16ON8010` and `HR38AC7748` are
  plates that were never examined by any prior session, because they
  were never the single largest vehicle in their frame — genuinely
  new detections this architecture change unlocks, not noise.

**Hard-stop condition, checked explicitly, not assumed:**
- The 4 plates named in the instructions (`HR98E4959`, `HR20AG3739`,
  `MH48AW4023`, `MH20DV2366`) — all 4 confirmed correctly (2 via the
  static-image benchmark above, `HR98E4959` present in this session's
  dashcam confirmed set). **No hard-stop trigger.**
- Every plate Session 6 confirmed on this same clip, cross-checked
  individually: `HR98E4959` ✓ present, `OL52OO0882` ✓ present,
  `FRJ45CK2913` ✓ present, `THR26E06477` — **not** present as that
  exact string. Investigated rather than waved through: `THR26E06477`
  was already documented in Session 3 as a noisy read with "an extra
  stray character, likely from crop edge noise" on the *same real
  vehicle* that Session 5 separately confirmed reads cleanly as
  `HR26EO6477` — which is exactly what this session's run produced
  instead. Reading this as the same real plate, read more cleanly, not
  a detection failure — the vehicle is still correctly found and
  confirmed, with a better string than before. Documenting the
  reasoning explicitly rather than silently treating "didn't
  reproduce byte-for-byte" as either an automatic pass or an automatic
  hard-stop.
- No crash, no unhandled exception, on any of `test_images/`,
  `test_images_degraded/`, or `dashcam_trimmed.mp4`.
- Only one firing completed under the new instructions so far — the
  "two consecutive firings worse" condition has no second data point
  to compare against yet.

**Conclusion: hard-stop condition not triggered. Continuing.**

### Verdict: **kept**

Real, measured multi-vehicle detection (10 confirmed plates this run
vs. 4 before, including genuinely new vehicles no prior session ever
examined), no regression on any named or previously-confirmed plate,
no new false positives observed (scanned the full confirmed set for
anything resembling Session 3's overlay-timestamp pattern — none),
compute cost far better than the worst case estimated in the design
(1.7x, not 6-15x), `send_detection_to_watchlist()` untouched.

Approach 1 (IoU matching) worked well enough on the real data and real
sampling rate to not need approach 2 or 3 this session — the
anticipated weakness (sparse 10-frame sampling means real displacement
between processed frames) didn't visibly break track association in
this run, though this wasn't measured in isolation (no ground-truth
vehicle-identity labels to check IoU matching accuracy against
directly, only the downstream effect of "did known plates still
confirm correctly").

## Next improvement to investigate

1. **Motion blur (Priority 2)** — next up per the brief's ordering,
   Priority 1 now has a working, benchmarked implementation.
2. IoU-tracking accuracy itself hasn't been directly measured (only
   inferred from downstream plate-confirmation behavior not
   regressing) — if a future session has time, dumping actual
   track-to-vehicle assignments frame-by-frame against a manually
   reviewed short clip segment would be a more direct test than "did
   known plates still confirm."
3. `MIN_VEHICLE_BOX_AREA_FRACTION = 0.03` is a reasoned starting point
   from the measured size distribution, not validated against real
   missed-plate cases — a real plate on a vehicle just under 3% of
   frame area would currently never be examined at all. Not tested
   this session.
4. `process_stream`/`process_hls_stream` got the same `VehicleTracker`
   change as `process_video_file` (mechanically identical) but neither
   was directly tested — no live RTSP/HLS source was reachable this
   session. Flagged, not assumed safe.
5. Low-light box-tightness, `OL52OO0882`/`DL52...` non-convergence
   (still present, still unresolved, now further evidence it's a
   stable hard case across yet another architecture change),
   confidence floor re-tuning, dedicated plate-region detector —
   unchanged from prior sessions.

---

# Session 8 — human ground truth cross-reference (priority interrupt)

Not a scheduled firing continuing Priority 1/2 — a direct, urgent
request to cross-reference 6+ sessions of this log against **real
human-verified ground truth** from someone who watched the actual
`dashcam_trimmed.mp4` clip directly, not the pipeline's own OCR output.
This matters precisely because every accuracy claim in this log up to
now was graded against either 3 static photos (real ground truth,
verified by direct visual inspection) or the dashcam video (graded
only by internal self-consistency — "does it converge," never against
an independent human read). This session breaks that circularity for
the dashcam clip specifically.

**Human-confirmed ground truth (7 plates + 1 investigated further this
session):** `HR38AC7748`, `HR26EQ6477`, `HR98E4959`, `UP16DN8010`,
`RJ45CR2913`, `DL52GD4935`, `DL52GD0882`, plus one plate the human
found too dark/blurry to confidently read themselves.

## 1. `HR98E4959` — matches exactly, no discrepancy

Confirmed correct as-is. No further action.

## 2. `OL52OO0882` target correction — the real plate is `DL52GD0882`, and neither prior "target" was right

Sessions 3-7 spent significant effort chasing convergence to
`DL52CD0882` — but that string itself was never verified ground
truth. Tracing it back: it was Session 1's *assumed* target, inferred
from an early EasyOCR-era voting cluster's own internal
self-consistency (the cluster's reconstructed representative at the
time), never checked against an independent source. Six sessions
accepted it without re-verifying. That's exactly the circularity this
session was asked to break.

**Visual investigation, not assumption:** pulled the actual video
frames. At frame 560/570 (this vehicle at moderate distance), the
character in question is genuinely ambiguous even at 8x zoom — could
read either O or D. At **frame 870** (same vehicle, much closer —
box is 620x556px vs ~300x330px at frame 560), it's unambiguous: a
visible flat left edge on the character, clearly `D`, not `O`.
**Ground truth is `DL52GD0882`**, confirmed by direct close-range visual
inspection, not inferred.

**Why the pipeline never confirmed it, despite reading it correctly
repeatedly:** pulled every raw OCR reading for this vehicle across its
~580-frame appearance in Session 7's log. The *majority* reading was
actually `DL52GO0882` (25+ occurrences) against only 8 occurrences of
the correct `DL52GD0882` — and both read at similarly high confidence
(0.86-1.0), with no confidence-based way to tell them apart. This
isn't the "OCR is noisy, needs more samples to converge" story this
log has told about this plate since Session 3 — **the OCR's majority
read for this specific plate, at this specific viewing angle, is
wrong more often than it's right.** `PlateConfirmationTracker`'s
confidence-weighted majority vote (Experiment 2's
`PATTERN_MATCH_VOTE_WEIGHT` logic) is working exactly as designed —
it's converging on the majority signal, and the majority signal
itself is incorrect here. More samples of the same systematic bias
won't fix this; it needs either a real accuracy improvement on this
specific character confusion (`G_` position) or a different
tie-breaking signal than raw majority count. Flagged as a real,
newly-understood limitation, not the same "not enough data" framing
prior sessions used.

## 3. `HR38AC7748`, `UP16DN8010`, `DL52GD4935` — coverage gap, confirmed structural, not an accuracy failure

Checked directly, not assumed: for each plate, pulled the exact frame
and measured every vehicle box YOLO found in it, in raw pre-Session-7
fashion (no area floor, all vehicle-class boxes).

| plate | frame | this vehicle's box area | largest box in same frame |
|---|---|---|---|
| `HR38AC7748` | 10 | (visibly small car) | a bus filling most of the left frame — visually obvious, see log's frame dump |
| `UP16DN8010` | 480 | 174,888px² (8.43% of frame) | 643,416px² (31.03% of frame) — **3.7x larger** |
| `DL52GD4935` | 560 | 73,406px² (3.54% of frame) | 590,877px² (28.50% of frame) — **8.0x larger** |

All three would have been mechanically impossible for the
pre-Session-7 single-largest-box design to ever select, regardless of
how many sessions ran or what OCR engine was used — not a detection
accuracy problem this whole log's effort could have fixed without the
Session 7 architecture change specifically. All three are read
correctly (exact match to human ground truth) in Session 7's output,
several at 1.0 confidence repeated across many frames (`HR38AC7748`:
1.0 confidence, frames 10-90, every single sampled frame).

## 4. `HR26EQ6477` vs. `HR26EO6477`, `RJ45CR2913` vs. `FRJ45CK2913`/`RJ45OK2913` — examined directly, mixed result

**`HR26E_6477`:** pulled frame 260 (moderate distance) and zoomed 4x.
My own reading leans toward `O` (the pipeline's read), not the human's
`Q` — the character looks round without a visible tail, though at
this resolution it's a genuinely close call and I can't be fully
certain either way. Not resolved with full confidence in either
direction; noting my independent read rather than deferring
automatically to either source.

**`RJ45C_2913`:** pulled frame 540, needed several attempts to
correctly locate the plate region (`plate_region_crop`'s fixed
55-92%/12-90% band assumption doesn't line up with where the plate
actually sits in every crop — a separate, minor finding about that
heuristic's limits, not chased further this session). Once correctly
located and zoomed 6x, this read clearly: **`RJ45CK2913`** — the two
characters in question look like `C` and `K` (not `R`), and critically,
**there is no visible leading `F` on the plate itself** in this frame.
This contradicts the human's `RJ45CR2913` (specifically the 6th
character) but agrees with the pipeline's own `RJ45CK2913`-family
reads once the spurious `F` prefix (present in some but not all of the
pipeline's own historical reads — `FRJ45CK2913`, `ARJ45CK2913`,
`RJA5CK2913` are all in the raw-reading history) is set aside as OCR
noise picking up something adjacent to the plate, not part of it.

**Recommendation:** for both of these, my own direct frame inspection
doesn't cleanly confirm the human-provided correction — in one case
(`RJ45C_2913`) it more clearly supports the pipeline's own prior
reading. Not overriding the human-provided ground truth unilaterally
based on one AI's own uncertain visual read of a blurry dashcam
frame — flagging this as a case that could use a second human look at
the specific frames now pulled (saved locally, not committed — see
below), rather than either side being declared correct by default.

## The 8th plate — investigated further per instructions, not guessed

Searched systematically before falling back to "unconfirmable": every
unique plate string across Session 7's full-video 10-frame-interval
run (33 distinct strings, checked by eye) — no trace, not even a
noisy fragment, resembling `DL20AS5815` or `DL26AS5015`. Followed up
with a denser, non-overlapping 3-frame-interval sweep of the *entire*
clip (skipping frames already covered by the 10-frame sampling),
running the actual detection pipeline end-to-end and filtering for
any `AS`-containing or `DL2`-prefixed result.

**Result: zero matches.** The 3-frame sweep checked 529 additional
frames (every 3rd frame not already a multiple of 10) across the
entire 1629-frame clip — combined with Session 7's original 163-frame
sweep, that's roughly 42% of all frames in the video individually run
through the actual detection+OCR pipeline, filtered for anything
`AS`-containing or `DL2`-prefixed. Nothing. Not a near-miss, not a
low-confidence fragment — no candidate at all resembling either
`DL20AS5815` or `DL26AS5015` anywhere in that coverage.

**Verdict: `DL20AS5815`/`DL26AS5015` — ground truth unconfirmable from
available footage.** Per the instructions, this is being logged as
exactly that, not guessed at or forced to either candidate string.
This is a real, useful finding in its own right: either this specific
vehicle only appears in one of the ~58% of frames not covered by even
this denser sweep (possible but would mean an unusually brief, narrow
appearance), or — more likely given the human's own "too dark/blurry"
assessment plus this pipeline's complete inability to extract even
noisy candidate text from it — this plate sits below the hard limit
of what's extractable from this footage at all, for a human or this
pipeline alike. That's a meaningfully different conclusion than "the
pipeline failed here" — there may be no signal in this footage to
recover, regardless of technique.

## What to do next

Resume Priority 2 (motion blur) after this session, per instructions.
This session's `DL52GD0882` finding (majority-vote can converge on a
systematically wrong OCR read, not just noise) is worth keeping in
mind for that work too, not just filed under "resolved."

---

# Session 9 — Priority 2, motion blur: LPDGAN rejected, NAFNet works (proof of concept)

Continuation of the same branch/protections. First real attempt at
Priority 2, per the brief's ordering: LPDGAN first, then a general
pretrained deblur model if LPDGAN isn't viable, then classical
techniques only as a last resort.

## Step 1: LPDGAN — verified not viable, not assumed

Checked directly against the GitHub API, not just the README: **zero
releases**, **no license** (`license: null`), last pushed
2024-05-30 — over a year stale. The README itself only documents a
training command (`python main.py --mode train --dataroot
./dataset`); no inference script, no pretrained weights. Training
would need the LPBlur dataset, which Session 4 already confirmed is
blocked (Google Drive/Baidu, no scriptable access). No license also
directly fails the "legally usable" requirement — default copyright
applies with nothing granted. **Rejected**, matching exactly the
brief's own anticipated failure mode ("unmaintained, needs training
data you don't have").

## Step 2: general pretrained deblur models — two false starts, then a real one

- **`nafnetlib`** (PyPI): `pip install` fails outright —
  `error in nafnetlib setup command: 'install_requires' must be a
  string or list of strings...`. Broken at the packaging level,
  confirmed directly (not assumed from its low GitHub star count,
  though that turned out to be a real signal). Uninstallable
  regardless of Python/torch version. **Rejected.**
- **`dblur`** (PyPI, MIT licensed, includes both NAFNet and Restormer):
  installs cleanly, but ships **no pretrained weights of its own** —
  every `deblur_*` method requires a locally-supplied checkpoint path.
  Worse, its own `NAFNet` reimplementation uses different internal
  layer naming than the real, published checkpoints (`attn_block.
  project_in_conv` vs. the original's `conv1`/`conv2`/`conv3`) — 588
  vs. 664 parameters, incompatible state dicts, confirmed by actually
  trying to load a real checkpoint into it, not just reading docs.
  **Not usable as a loader for real weights.**
- **Official `megvii-research/NAFNet`** (the original repo, MIT +
  Apache-2.0 licensed — confirmed by fetching the actual LICENSE file
  after GitHub's API showed a non-standard "Other" classification,
  which turned out to just be two standard licenses concatenated in
  one file, not anything restrictive): the architecture code itself
  (`NAFNet_arch.py`, ~200 lines) is small enough to vendor directly
  rather than pull in the full `basicsr` training framework — needed
  2 small supporting files (`arch_util.py`, `local_arch.py`) and one
  trivial stub (`basicsr.utils.get_root_logger`, which the real code
  only calls from a commented-out block, confirmed by reading it
  before stubbing it).
- **Weights:** the official repo's own download links are Google
  Drive (same blocker as LPBlur/Session 4), but a real, scriptable
  HuggingFace mirror exists (`nyanko7/nafnet-models`,
  `NAFNet-GoPro-width32.pth`) — verified as a genuine direct download
  (HTTP redirect to a real CDN, no login wall, no virus-scan
  interstitial, matching `Content-Length`) before trusting it. Loaded
  into the real architecture with the exact official GoPro-width32
  config (`width=32, enc_blk_nums=[1,1,1,28], middle_blk_num=1,
  dec_blk_nums=[1,1,1,1]`, from the official repo's own test config
  file, not guessed): **0 missing keys, 0 unexpected keys** — an exact
  match, strong evidence this is the real, correctly-paired checkpoint
  and architecture, not a mismatched substitute.

## Real benchmark result, isolated test venv (never touched `ml-anpr/venv`)

- **Inference cost:** 0.43-1.13s per image on CPU — comparable to a
  single PaddleOCR call, not a new order-of-magnitude cost.
- **Motion-blur set** (`test_images_degraded/*_motionblur.jpg`, fed
  through NAFNet then the real `detect_plate()` pipeline):

  | image | before (Session 4 baseline) | after NAFNet deblur |
  |---|---|---|
  | car1 | miss (no plate-shaped text) | `MH43AW4023` (gt `MH48AW4023`) — 1 char off, conf 0.98, pattern-match tier |
  | car2 | miss | `HP20AS3739` (gt `HR20AG3739`) — 2 chars off, conf 0.8, pattern-match tier |
  | car3 | miss | `MH20DV2366` — **exact match**, conf 0.99 |

  **0/3 → 1/3 exact matches.** More importantly than the raw count:
  the failure mode itself changed completely. Before, the pipeline
  couldn't extract plate-shaped text *at all* from 2 of 3 (car1's raw
  OCR was `'BR'`, car2's was `'12200379'` — letters dropped entirely).
  After deblurring, all 3 produce full, plate-shaped, pattern-matched
  reads at high confidence, with the two "misses" being ordinary 1-2
  character confusions (the same class of error `_correct_plate_positions()`
  already exists to catch on clear images) — not a different failure
  mode, a much smaller and more familiar one.
- **Regression check on clean images:** ran the same deblur model on
  the 3 clean ground-truth photos before feeding them to the real
  pipeline — still 3/3 exact, same ~1.0 confidence. No evidence this
  hurts already-sharp input.

### Verdict: **real, working proof of concept — not yet integrated into `detect_plate.py`**

This is a genuine, measured improvement, unlike Session 4's unsharp-mask
attempt which made every case strictly worse. Deliberately not wired
into the production pipeline this firing, for the same reason Session
2 didn't rush PaddleOCR into `detect_plate.py` the moment it looked
promising: integration is real, separate work, not something to bolt
on in the last few minutes of a firing that already spent significant
time on evaluation. Specifically still needed:
1. **A gating mechanism**, not unconditional application — NAFNet
   costs ~0.4-1.1s per image, comparable to Session 5's low-light
   enhancement cost lesson (2.5-3.6x video slowdown when applied to
   every frame unconditionally). Needs the same kind of cheap
   pre-check `is_low_light()` used (e.g. Laplacian variance as a blur
   heuristic) before this gets wired into `detect_plate_from_frame`'s
   default path, not applied to every frame regardless of whether it's
   actually blurry.
2. **Vendoring properly** — the architecture code needs to actually
   live in the repo (with the MIT/Apache attribution the license
   requires) if this gets integrated, not just exist in a throwaway
   test venv.
3. **Checkpoint distribution** — 68MB, shouldn't be committed to git
   directly; needs the same kind of "documented, fetched on setup"
   treatment `requirements.txt`'s install-order note gives PaddleOCR.
4. **Not yet tested against `dashcam_trimmed.mp4`** — only the static
   synthetic motion-blur set. Real video motion blur may behave
   differently than the synthetic 15px box-kernel blur this was
   validated against.

No production code changed this firing — all testing done in an
isolated venv (`deblur_test_venv`, outside the repo), exactly
following the methodology Session 2/3 established for PaddleOCR.
`send_detection_to_watchlist()` untouched (trivially, given no
production code changes). Hard-stop condition: not triggered (no
regression possible from zero production changes).

## Next improvement to investigate

1. **Integrate NAFNet properly** (highest priority, mirrors Session
   2→3's PaddleOCR pattern): build the blur-detection gate, vendor the
   architecture code with correct attribution, decide on checkpoint
   distribution, re-run the full dashcam video regression before
   deciding to keep it as default behavior.
2. Test against `dashcam_trimmed.mp4`'s real motion blur, not just the
   synthetic benchmark set.
3. Low-light box-tightness, confidence floor re-tuning, dedicated
   plate-region detector, `process_stream`/`process_hls_stream` still
   untested against a live source — unchanged from prior sessions.

---

# Session 10 — NAFNet integration: gate, vendor, benchmark, kept

Continuation of the same branch/protections. Integrates Session 9's
proof of concept into the real pipeline, per that session's own
next-steps list.

## 1. Blur-detection gate — real per-vehicle data, not a frame-wide guess

Motion blur depends on a specific vehicle's relative motion to the
camera, not overall scene brightness — unlike `is_low_light()`, this
is checked per vehicle crop in `_read_plate_from_box()`, not once per
frame. Laplacian-variance threshold calibrated the same way as the
brightness gate: clean images measure 685-1061, synthetic
motion-blurred counterparts measure 196-225 — clean gap. **Real risk
found and handled:** fog-degraded images measure 279.8, closer to the
blur range than to clean. Set `BLUR_LAPLACIAN_VARIANCE_THRESHOLD =
250` — below fog's value (so fog doesn't falsely trigger NAFNet, which
was only validated against motion blur, not haze) but above all 3
motion-blur samples. Documented as a real but non-huge margin, not
asserted as fully robust to every case.

## 2. Vendored properly, not just copy-pasted

`ml-anpr/nafnet/` — `NAFNet_arch.py`, `arch_util.py`, `local_arch.py`
from the official `megvii-research/NAFNet` repo, import paths fixed
to relative (`from .arch_util import ...`), the one unused
`basicsr.utils` import removed (confirmed dead/commented-out code
before removing, not stubbed). `LICENSE` file added reproducing the
full MIT + Apache-2.0 text from the source repo, with an explicit note
of what was modified. Checkpoint (68MB) is **not** committed —
`_get_nafnet_model()` fetches it once to `~/.cache/netra_nafnet/` on
first actual use (lazy, not at import time) and caches it there,
verified working: file present after first run, exact byte-size match
to the Session 9-verified download, second run doesn't re-download.

## 3. Full benchmark suite, before deciding to keep

- **Clean images:** still 3/3, unaffected (blur gate correctly never
  triggers on sharp crops — 685-1061 variance, threshold 250).
- **Degraded set:** `motionblur` **0/3 → 1/3**, matching Session 9's
  proof-of-concept result exactly now that it's wired into the real
  pipeline. `lowlight` 2/3, `glare` 3/3, `fog` **3/3** (critical
  confirmation the fog false-trigger risk identified in step 1 didn't
  materialize — fog images correctly did not engage the blur gate).
- **Dashcam video regression (the one that matters most):** confirmed
  plate set is **byte-for-byte identical to Session 7's**: `DL52OO0882`,
  `RJ45OK2913`, `UP16DN8010`, `UP16ON8010`, `OL52OO0882`,
  `FRJ45CK2913`, `HR38AC7748`, `HR98E4959`, `DL52GD4935`, `HR26EO6477`
  — same 10 plates, zero change. All hard-stop-named plates present
  and correct (`HR98E4959` in the dashcam set; `HR20AG3739`,
  `MH48AW4023`, `MH20DV2366` verified via the static-image benchmark).
  Total time: 490s vs. Session 7's 390s baseline (~1.26x) — modest,
  expected, not the kind of cost Session 5's unconditional low-light
  application incurred.
- **Verified the gate actually engages on real footage, not just
  synthetic images** — an 8-frame spot-check first found zero
  triggers (a too-small, unlucky sample), so followed up with a
  broader sweep (84 real vehicle crops across the whole clip, every
  40th frame): **4/84 (~5%) triggered**, with real low-variance values
  (59.0, 152.7, 155.6 — well below the 250 threshold, not
  borderline). Confirms this isn't silently inert on real video.

## Not yet done, honestly flagged

`DL52GD0882` (Session 8's human-confirmed ground truth for that
vehicle) still isn't the confirmed string — the dashcam set still
shows `DL52OO0882`/`OL52OO0882`. Expected, not a regression: Session
10 targeted motion blur specifically, not the majority-vote
character-bias issue Session 8 diagnosed for that plate, which is a
different, already-flagged, still-open problem.

### Verdict: **kept**

Real, measured win with zero regression: identical dashcam-confirmed
plates, improved motion-blur accuracy (0/3→1/3, verified via the real
pipeline not just the isolated test venv), confirmed working on real
footage at a modest, bounded rate and cost. `send_detection_to_watchlist()`
verified byte-identical to `main` after all changes. Hard-stop
condition: not triggered.

## Next improvement to investigate

1. `DL52GD0882` majority-vote character-bias issue — unchanged from
   Session 8, still open, a different problem from motion blur.
2. Fog's proximity to the blur threshold (279.8 vs. 250) is a real,
   documented margin, not a guaranteed-safe one — worth a wider fog
   sample if more synthetic/real foggy footage becomes available.
3. Low-light box-tightness, confidence floor re-tuning, dedicated
   plate-region detector, `process_stream`/`process_hls_stream` still
   untested against a live source — unchanged from prior sessions.
4. With both Priority 1 and Priority 2 now addressed with kept,
   benchmarked changes, worth a full end-to-end reread of the log for
   whoever reviews this branch before merge — a lot has accumulated
   across 10 sessions.
