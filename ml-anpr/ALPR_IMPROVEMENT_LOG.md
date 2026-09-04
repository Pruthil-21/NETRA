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

---

# Session 11 — DL52GD0882 investigated deeper, no safe fix found this firing

Continuation of the same branch/protections. Both stated priorities
are done (Sessions 7, 9, 10). This firing worked the log's own
next-priority item: the `DL52GD0882` majority-vote issue Session 8
diagnosed.

## Deeper root cause found — Session 8's framing was real but incomplete

Session 8 attributed this to confidence-weighted majority voting
converging on the OCR's more-frequent-but-wrong character read (`GO`
appearing more than the correct `GD`). Pulled the actual confirmation
event log (not just the raw readings) to check exactly when and why
each confirmation fired, and found a more specific, more important
cause:

- `DL52OO0882` (wrong in **two** positions, not the `GD`/`GO` question
  at all) confirms almost immediately at frame 560, confidence 0.97 —
  **before** almost all of the 33 `GD`/`GO` readings this vehicle
  produces even occur (frames 570-1160). `PlateConfirmationTracker`
  only needs `confirm_threshold=2` matching readings to lock in, so
  this fires on very early, still-noisy data.
- Once locked, the **duplicate-alert guard** (`if any(_plate_similarity(...)
  >= threshold for c in self.confirmed)`) permanently blocks that
  track's tracker from ever confirming a *different* string again —
  so none of the dozens of subsequent readings, including the correct
  `DL52GD0882`, can ever override the early wrong lock, no matter how
  much stronger the later evidence is.
- **A third factor, not previously documented:** a *separate* track
  independently confirms `OL52OO0882` at frame 770. This is very
  likely the same physical vehicle, tracked as a second `VehicleTracker`
  fragment — exactly the sparse-10-frame-sampling track-continuity risk
  Session 7's own design section flagged as a known weakness of
  approach-1 IoU matching, now showing up concretely on a real,
  long-lived (~600-frame, ~20 second) vehicle appearance.

**So the real story is:** premature single-track lock-in *and*
multi-track fragmentation, compounding — not simply "majority vote
picked the wrong character," which was the right symptom but not the
full mechanism.

## Why no fix was attempted this firing

Both underlying issues (early-confirmation lock-in, IoU track
fragmentation on long/fast-moving vehicles) are used by *every* plate
this pipeline confirms, on every stream — not something scoped to this
one vehicle. A safe fix needs real design work: allowing a track's
confirmed value to be corrected by later, stronger evidence without
either (a) reopening the duplicate-alert spam problem the guard exists
to prevent, or (b) needing a full redesign of track association
(Session 7's approach 2/3 escalation path — centroid tracking or
ByteTrack — which the original Priority 1 brief explicitly said only
to pursue with evidence approach 1 is insufficient, and this session's
finding is exactly that kind of evidence, just not yet acted on).
Either fix touches core, shared logic and needs a full-suite
regression re-run under the hard-stop policy — not something to force
through as "one well-scoped piece" alongside everything else already
changed this branch. Per the brief's own explicit allowance:
**investigated thoroughly, no safe/justified change implemented this
firing.**

No code changed. `send_detection_to_watchlist()` untouched (trivially).
Hard-stop: not triggered (no changes, no regression possible).

## Next improvement to investigate

1. **`DL52GD0882` fix, properly scoped as its own dedicated session:**
   two candidate directions now identified with real evidence --
   (a) allow a track's confirmed representative to be corrected if a
   sufficiently stronger cluster forms later in the same track's life
   (needs care to not reintroduce duplicate alerts), (b) escalate
   Session 7's tracking approach past simple IoU matching (centroid
   tracking or ByteTrack) specifically for long-lived, fast/far-moving
   vehicles where sparse sampling breaks box continuity -- this
   session's fragmentation finding is real evidence approach 1 has a
   real limit, which the original Priority 1 brief anticipated might
   happen.
2. Low-light box-tightness, confidence floor re-tuning, dedicated
   plate-region detector, `process_stream`/`process_hls_stream` still
   untested against a live source — unchanged, checking these next.

---

# Session 12 — low-light box-tightness fixed, kept

Continuation of the same branch/protections. Same firing as Session
11's DL52GD0882 investigation above (no safe fix found there); moved
to the next item, the low-light box-tightness bug flagged since
Session 5.

## Diagnosis: real, measured confidence gap

Re-checked `car1_lowlight.jpg`'s YOLO box directly: confidence
0.26-0.29. Compared against the primary (largest) vehicle box
confidence on the 3 clean ground-truth images: 0.536, 0.877, 0.833 --
a real, wide gap, not a marginal one. Confirmed the mechanism by
testing directly: expanding the box's bottom edge by 40% of its own
height recovered a plate that was otherwise completely unreadable
(`car1_lowlight.jpg`: no OCR text at all -> `MH.48.AW.4023` at 0.97
confidence).

## Fix: expand only low-confidence boxes, bottom edge only

`LOW_CONFIDENCE_BOX_THRESHOLD = 0.4` (sits with real margin between
the low-light case's 0.26-0.29 and clean images' 0.54-0.88 -- not
guessed), `LOW_CONFIDENCE_BOX_EXPAND_FRACTION = 0.4`. Only expands the
bottom edge (where the plate/bumper sits, and where under-detection
was actually observed), not the whole box in every direction --
narrower change, lower risk of pulling in adjacent vehicles or the
dashcam overlay band unnecessarily.

## Full benchmark

- **Clean images:** still 3/3, unaffected (all 3 primary-vehicle
  confidences are well above 0.4, so the expansion never triggers on
  them).
- **Degraded set:** `lowlight` **2/3 → 3/3** -- `car1_lowlight` now
  reads correctly. `motionblur`, `glare`, `fog` all unchanged.
- **Dashcam video regression:** 9 of 10 previously-confirmed plates
  identical to Session 10. One changed: `DL52OO0882` -> `OL52GO0882`.
  Investigated, not waved through: both strings are variants of the
  same vehicle cluster Session 8 already established has a
  never-yet-achieved correct answer (`DL52GD0882`, still not the
  confirmed string here either) -- this is lateral movement within an
  already-known-unresolved hard case, not a regression of something
  that previously worked, the same category of finding as Session 7's
  `THR26E06477` -> `HR26EO6477` shift. Every explicitly named
  hard-stop plate checked individually: all present and correct
  (`HR98E4959`, `HR38AC7748`, `UP16DN8010`, `DL52GD4935`,
  `HR26EO6477` all in the confirmed set; `HR20AG3739`/`MH48AW4023`/
  `MH20DV2366` verified via the static benchmark). Total time: 515s
  vs. Session 10's 490s -- negligible increase.

### Verdict: **kept**

Real, measured improvement (2/3->3/3 on the specific documented bug),
zero regression on any named or previously-stable plate, one lateral
shift within an already-flagged unresolved cluster, transparently
investigated and explained rather than glossed over.
`send_detection_to_watchlist()` verified byte-identical to `main`.
Hard-stop condition: not triggered.

## Next improvement to investigate

1. Confidence floor re-tuning -- still deferred, still no good
   calibration signal across 6+ sessions of looking.
2. Dedicated plate-region detector -- still blocked on a Roboflow API
   key not available in this environment.
3. `process_stream`/`process_hls_stream` -- still untested against a
   live source; check reachability next firing, don't block if
   unreachable (consistent with every prior session's finding that
   the demo tunnel is flaky).
4. `DL52GD0882` proper fix -- unchanged from Session 11, needs its own
   dedicated session (track-association or confirmation-locking
   redesign, both cross-cutting).

---

# Session 13 — remaining flagged items checked, no safe change found

Continuation of the same branch/protections. Worked through the log's
remaining flagged items in order.

## Quick checks (items 1-3)

- **Confidence floor re-tuning:** still no calibration signal --
  actually *more* evidence against attempting it now than before.
  Session 8 already showed both the correct and incorrect readings
  for `DL52GD0882` hit similarly high confidence (0.86-1.0) -- if
  confidence itself can't discriminate right from wrong on real data
  we have in hand, moving the floor threshold up or down doesn't
  address the actual problem. Staying deferred, now with a clearer
  reason why than "no evidence yet."
- **Dedicated plate-region detector:** still blocked, no Roboflow API
  key configured in this environment (checked directly).
- **Live stream reachability:** the demo Cloudflare tunnel URL from
  earlier sessions is unreachable (connection failure, not even an
  HTTP error) -- consistent with every prior session's finding that
  this tunnel is ephemeral/flaky. `process_stream`/`process_hls_stream`
  remain untested against a live source; not blocking on it.

## Item 4: `DL52GD0882` -- a candidate fix considered and rejected on paper, before writing code

Considered a narrower, lower-risk alternative to Session 11's two
heavier candidate directions: deduplicate *consecutive* identical
readings within a track before voting, so one persisting viewing
artifact (the long, unbroken `DL52GO0882` run identified in Session
11) can't dominate the confidence-weighted vote by sheer repetition.

**Checked directly against real data before implementing anything,
and rejected:** pulled `HR98E4959`'s own raw reading sequence --
the project's headline example, the one this whole effort has used
to demonstrate the confirmation system works. It shows the **exact
same shape**: 10+ consecutive, uninterrupted, identical readings
(frames 330-440, no other value interspersed for that track) before
confirming. A naive consecutive-deduplication rule can't tell
"correctly and consistently read plate" apart from "incorrectly and
persistently misread plate" -- both look identical from inside the
tracker (a long run of one repeated string). Implementing this would
very likely have prevented `HR98E4959` -- a named hard-stop plate --
from ever reaching `confirm_threshold` again. Caught by reasoning
through the actual data first, not by trial and error against the
benchmark.

This doesn't invalidate Session 11's conclusion; it reinforces it.
Both of Session 11's identified fix directions (allow corrected
re-confirmation, or escalate track association) remain the real paths
forward, and both are genuinely bigger, more careful pieces of work
than fit safely in a single autonomous firing under the hard-stop
policy -- not something a narrower shortcut sidesteps.

### Verdict: **no code change this firing**

No safe, evidence-backed improvement was found across all 4 flagged
items. Per the brief's own explicit allowance for this outcome:
investigated thoroughly, documented honestly, nothing forced through.

No code changed. `send_detection_to_watchlist()` untouched (trivially).
Hard-stop: not triggered (no changes, no regression possible).

## Next improvement to investigate

1. `DL52GD0882` -- still needs a genuinely dedicated session with its
   own careful design and full-suite regression testing, per Sessions
   11 and 13's combined analysis. Not a quick fix; two real candidate
   directions identified, neither attempted yet.
2. Everything else remains as documented across Sessions 1-12 --
   Priority 1 and 2 both done and kept, this branch is in a stable,
   fully-benchmarked state with one clearly-scoped remaining hard
   problem and no other currently-actionable items identified.

---

# Session 14 — two pre-merge review fixes: NAFNet error handling, numpy pin

Not a new experiment -- two small, well-defined fixes requested
directly from the final pre-merge review (which found the checkpoint
download had no error handling, and `numpy` was directly imported in
`nafnet/local_arch.py` but unpinned).

## Fix 1: NAFNet checkpoint download no longer crashes the pipeline

**Problem, exactly as the review found it:** `_get_nafnet_model()`'s
download call had zero exception handling. If the blur gate fired on a
machine with no cached checkpoint and no network access at that
moment, `requests.get(...)`/`raise_for_status()` raised an uncaught
exception that propagated through `enhance_motion_blur` ->
`_read_plate_from_box` -> `detect_plate_from_frame` and crashed the
entire `process_video_file`/`process_stream`/`process_hls_stream`
loop -- not just that one frame.

**Fix:** wrapped the download specifically (not the whole function --
a genuine model-loading failure on an already-cached file is a
different, real bug worth surfacing, not something to silently paper
over) in `try/except requests.exceptions.RequestException`. On
failure: logs `[WARN] NAFNet checkpoint unavailable (...), skipping
deblur for this frame`, removes any partial/corrupt file so a future
process can retry cleanly once the network is back, sets a
module-level `_nafnet_unavailable` flag so a dead network doesn't get
hammered with a fresh download attempt on every subsequent blurry
frame in the same process, and returns `None`.
`enhance_motion_blur()` returns the original, un-enhanced crop
unchanged when the model is unavailable -- the caller doesn't need to
know or care, processing continues normally with whatever the
pre-NAFNet pipeline would have done.

**Tested directly, not just reasoned about:** moved the cached
checkpoint aside, monkey-patched the checkpoint URL to an unreachable
domain, and called the actual functions:
- `enhance_motion_blur()` on a real blurry crop: completed in 0.24s
  (a genuine DNS resolution failure, not a hang), printed the warning,
  returned the original image byte-for-byte unchanged, no crash.
- Called again immediately: 0.00s, no second download attempt --
  confirms the failure-caching behavior works.
- Full `detect_plate()` pipeline under the same simulated failure:
  completed normally, fell back to the pre-NAFNet result (no crash,
  no plate found -- exactly the expected pre-Session-9 behavior for
  that image).
- Restored the real checkpoint and re-verified normal operation
  resumed in a fresh process: `motionblur` back to 1/3, matching
  Session 9/10 exactly.

## Fix 2: `numpy==2.0.2` pinned in `requirements.txt`

Matches what's actually resolving in the tested environment (verified
via `pip show numpy` before pinning, not guessed).

## Full regression suite, post-fix

- **Clean images:** 3/3, unaffected.
- **Degraded set:** `lowlight` 3/3 (Session 12's fix, unaffected),
  `motionblur` 1/3 (Session 9/10's result, unaffected), `glare` 3/3,
  `fog` 3/3 -- all unchanged.
- **Dashcam video:** confirmed plate set is **byte-for-byte identical**
  to the last full review's baseline (10 plates, zero difference,
  checked programmatically with a set diff, not eyeballed). Every
  named hard-stop plate individually verified present and correct.
  512s total -- statistically the same as the prior 515s baseline, as
  expected (the fix only adds a try/except wrapper on the success
  path, no new per-frame cost).
- `send_detection_to_watchlist()`: verified byte-identical to `main`
  one final time.

### Verdict: **both fixes kept**

Real failure mode fixed and verified working under an actual
simulated failure, not just code review -- exact scenario the
pre-merge review flagged (cold machine, blur gate fires, network
unreachable) now degrades gracefully instead of crashing. Zero
regression across every benchmark. `main` untouched throughout.
Nothing pushed or merged, per instructions.

---

# Session 15 -- Priority 0: `send_detection_to_watchlist()` moved to the new `POST /detections` contract

Deliberate contract update, not an experiment. P6 retired `POST /alerts`
in favor of `POST /detections` (origin/main @ `cee989d`,
`b09d1e2 feat(watchlist): add vehicle detection history + unify ANPR
ingestion into POST /detections`). Local `main` in this checkout was
still on `72cb8af`, one merge behind -- `git fetch origin main` (fetch
only, local `main` branch pointer never moved) was needed before the
new contract was visible at all. Verified the new shape three ways
before writing any code, not just from the task description: the
updated `contract/API_CONTRACT.md`, the real
`backend-watchlist/app/routers/detections.py`, and
`backend-watchlist/app/schemas.py`'s `DetectionIn` -- all three agree.

## What changed

- `ALERT_API_URL` -> `DETECTION_API_URL`, now points at `.../detections`
  instead of `.../alerts`. The `# CONFIRM WITH P6 BEFORE DEMO` comment's
  item 1 (endpoint path) is resolved; items 2-3 (real internal key,
  camera_id mapping) are still open and still flagged.
- `send_detection_to_watchlist(plate_number, camera_id_str)` gained a
  third parameter, `confidence=None`, sent as `"confidence"` in the
  POST body -- `DetectionIn.confidence` is `Optional[float]`, so `None`
  serializes to JSON `null`, which the schema accepts. Both call sites
  (in `process_stream` and `process_video_file`) already had
  `confirmed["confidence"]` on hand from
  `PlateConfirmationTracker.add()`'s return value, so no new plumbing
  was needed to source it.
- Response handling rewritten for the new contract shape. The old
  `/alerts` returned `201` (match) or `204` (no match). The new
  `/detections` always returns `201` with `{detection, alert}` --
  `alert` is `null` on no-match. Now checks
  `response.json().get("alert") is not None` to decide whether to print
  `[ALERT]`, instead of branching on status code.
- Nothing else in the detection/tracking pipeline touched, per the
  brief.

## Testing

**Real end-to-end call: not possible from this machine.** The
configured backend at `192.168.31.11:8001` is an unreachable LAN
address from here (confirmed via `curl -m 3`, connection failed
outright), and no local Docker/Postgres stack is available to stand up
the real service (`docker` isn't installed on this machine). Rather
than skip verification or fake a "tested end-to-end" claim, wrote a
throwaway local mock server
(`scratchpad/mock_detections_server.py`, not committed) that mimics
the exact documented contract shape and asserts the client's request
is well-formed (`camera_id` is `int`, `plate_number` is `str`,
`confidence` key present, `X-Internal-Key` header present), then
pointed `send_detection_to_watchlist()` at it for three cases:
no-match, watchlist-match (confirmed `[ALERT]` line prints with the
mock's returned alert object), and `confidence=None`. All three
completed without exception. This validates the client's request/
response handling against the contract's exact shape; it is explicitly
**not** a substitute for a real call against the actual
backend-watchlist service, which still needs to happen once that
service is reachable (flagged, not silently assumed done).

**Static images:** 3/3, unchanged (`MH48AW4023`, `HR20AG3739`,
`MH20DV2366`).

**Degraded set:** `lowlight` 3/3, `motionblur` 1/3, `glare` 3/3, `fog`
3/3 -- all unchanged from Session 14.

**Dashcam video, with a deliberate extra step:** first run (post-change
code) confirmed set differed from the last documented baseline in
exactly one entry -- `DL52OO0882` (baseline) was replaced by
`OL52GO0882`. Everything else, including every named hard-stop plate
(`HR98E4959`, `HR38AC7748`, `UP16DN8010`, `DL52GD4935`, `HR26EO6477`),
was identical. Since this change cannot touch OCR/tracking logic at
all (it only affects what happens after a plate is already confirmed),
a real regression here would have been surprising -- but "surprising"
isn't "impossible," so this was checked directly rather than
hand-waved: `git stash`ed the Priority 0 diff, reran the identical
dashcam video against the untouched pre-change code, and got
`OL52GO0882` again, not `DL52OO0882`. Same result with and without the
change -- proves this is pre-existing run-to-run nondeterminism in the
already-documented, still-unresolved `DL52GD0882` cluster (Sessions 8/
11/13), not a regression this change introduced. `git stash pop`
restored the Priority 0 diff before committing.

`send_detection_to_watchlist()` is now *intentionally* different from
`main` -- that's the entire point of this session, since `main`'s copy
still points at the retired `/alerts` endpoint. The "verify byte-
identical to main" check from Sessions 1-14 no longer applies to this
function specifically; it's superseded by "verify against the real,
current backend-watchlist contract," which is what the three-way check
above did.

### Verdict: **kept**

Contract change implemented and verified against the real route code
(not just the docs, which could itself have lagged), client-side
request/response handling verified against a contract-shape-accurate
mock (real end-to-end blocked by environment, not skipped silently),
zero regression on every benchmark that's actually sensitive to this
change, and the one observed difference was independently proven to be
pre-existing nondeterminism rather than caused by this change. `main`
untouched throughout (confirmed `git log --oneline main -1` still
`72cb8af` before and after -- only `origin/main`'s remote-tracking ref
moved, via `fetch`, never the local branch itself). Nothing pushed or
merged.

## Next

Priority 1 (`DL52GD0882`) is next, per the brief's own sequencing
("once Priority 0 is done and verified"). Deferred to the next firing
rather than started here, consistent with every prior session's
one-well-scoped-piece-per-firing discipline -- it's explicitly the
bigger, higher-risk piece of work in the brief, needs its own design
written before any code, and needs the same full-suite + HR98E4959-
specific care this session just modeled for a much smaller change.

---

# Session 16 -- Priority 1: `DL52GD0882` design investigation, both candidate directions ruled out with new hard evidence

Per instructions: design written and evidence gathered *before* any
code. Started from Session 11's two candidate directions -- (a) allow
a track's confirmed value to be corrected by significantly stronger
later evidence, without reopening duplicate-alert spam, or (b)
escalate track association past IoU (centroid tracking first) for
long-lived fast-moving vehicles. Both are now ruled out, with harder
evidence than Sessions 8/11/13 had, for a reason neither prior session
identified: **there is no stronger evidence for the correct answer
anywhere in this vehicle's own reading history, under any weighting
scheme tested.** This isn't a tracking or confirmation-logic bug at
all -- it's an OCR character-confusion limitation that the
confirmation layer structurally cannot see past.

## Method: instrumented the real pipeline, not a synthetic replay

Wrote a diagnostic that runs `detect_plate_from_frame` across the full
dashcam clip (same 10-frame sampling as `process_video_file`) and logs
every raw reading belonging to this vehicle's plate family --
`(frame, track_id, plate_string, confidence, note, box_area)` -- by
replicating `VehicleTracker`'s own IoU matching alongside the real
`tracker.update()` call, not a separate/synthetic run. Confirmed the
same fragmentation Session 11 found: this one physical vehicle
produces at least 3 separate `VehicleTracker` track fragments across
its ~750-frame appearance (`track 5726498624`: frames 540-630;
`track 5726496896`: frames 750-1290, the one long enough to actually
matter; `track 5726549056`: frame 1290 only, likely a 4th fragment or
tail noise) -- each with its own independent, empty `confirmed` set,
exactly the mechanism Session 11 identified for duplicate alerts on
one vehicle.

## The actual vote tally, from real data, not assumed

Isolated the single ambiguous character position (`DL52G_0882` vs.
`DL52O_0882` family -- the 6th character, `D` vs `O`) across track
`5726496896` alone (frames 750-1160, 42 readings, the track that would
actually reach `confirm_threshold` and lock in a value) and tallied
every weighting scheme the two candidate directions could plausibly
use to pick a "stronger" answer:

| character | count | confidence-sum | box-area-sum |
|---|---|---|---|
| `O` (wrong) | 34 | 32.10 | 6,411,388 |
| `D` (correct) | 8 | 7.69 | 1,841,929 |

`O` wins by **4.3x on raw count, 4.2x on confidence-weighted sum, and
3.5x on box-area-weighted sum**. Every metric available to the
confirmation layer says `O` is the stronger signal -- because, in this
specific footage, it genuinely is the more common OCR output for this
character, not a rare fluke a bit more data would wash out.

This also directly retests Session 8's box-size hypothesis (frame 560,
small/far box, ambiguous; frame 870, large/close box, unambiguously
`D`) against the full data, not just those two frames. It doesn't
hold up: `D` occurs at both small boxes (frame 1160: 72,380px²) and
large boxes (frame 900: 392,942px²), and so does `O` (frame 920:
400,890px², larger than any `D` frame) -- box size correlates with
overall image quality generically, but does not correlate with
*which* character this specific OCR engine reads at this position.
Checked directly and found not to generalize, rather than assumed
from two data points.

## Why this rules out both candidate directions specifically

- **(a) Correct a locked-in value via significantly stronger later
  evidence:** there is no later evidence stronger than the wrong
  answer to correct *to*. The wrong cluster (`O`) has more support by
  every measure across the entire track, not just in the early frames
  that cause premature lock-in. A "smarter" correction rule doesn't
  have a correct target to converge toward with this pipeline's actual
  OCR output on this footage -- it would either still lock onto `O` (if
  it re-evaluates the same majority logic later) or require inventing
  a new signal with no basis in the data (arbitrary/unjustified,
  exactly what this project's discipline has consistently avoided).
- **(b) Fix track fragmentation (centroid tracking):** would reduce the
  *number* of separate alerts fired for this one vehicle (today, up to
  3 independent tracks each get their own shot at confirming and
  alerting) -- a real, legitimate improvement in its own right. But it
  would **not** fix the plate string: pooling all fragments' readings
  into one track still leaves `O` dominant by the same ~4x margin
  shown above (fragment 1's readings lean `O`/`OO` too -- see the raw
  log: `OL52OO0882`, `DL52OO0882` at frames 540-630). Implementing a
  full track-association rework -- cross-cutting logic touching every
  confirmed plate in the pipeline, needing the same careful
  full-suite + HR98E4959-specific reverification as any other change
  here -- for a benefit that's real but doesn't solve the named
  problem (the alert would still carry the wrong plate number, just
  once instead of up to three times) isn't a good risk/benefit trade
  for an unattended firing under the hard-stop policy.

## What this actually is

Restates and sharpens Session 8's own conclusion: this needs "either a
real accuracy improvement on this specific character confusion, or a
different tie-breaking signal than raw majority count" -- and this
session's contribution is showing concretely that **no tie-breaking
signal available at the confirmation-tracking layer exists** for this
case; every signal tested points the same wrong way. A real fix would
need to change what happens *before* confirmation -- e.g. a better/
fine-tuned OCR model, an ensemble of OCR engines voting independently
per character, or manual correction against a real plate registry --
none of which are safe, well-evidenced, one-firing changes to attempt
unattended, and several (model fine-tuning, ensembling) are
substantial enough to need their own dedicated scoping the same way
NAFNet did (Sessions 9-10).

### Verdict: **no code change this firing**

Both of the brief's candidate directions are ruled out with concrete
evidence, not risk-aversion alone: (a) is mathematically incapable of
producing the correct answer given this pipeline's actual OCR output
on this footage, and (b) doesn't solve the named problem even though
it's a legitimate smaller improvement on its own. Per the brief's own
explicit allowance for this outcome, and consistent with Sessions 11
and 13's same call: investigated thoroughly, documented with harder
evidence than either of those sessions had, nothing forced through.

No code changed. `send_detection_to_watchlist()` untouched (trivially,
no code touched at all this firing). Hard-stop: not triggered (no
changes, no regression possible). `main` untouched
(`git log --oneline main -1` still `72cb8af`). Nothing pushed or
merged.

## Recommendation for a human decision (not something to act on unattended)

`DL52GD0882` should be treated the same way Session 8 treated the
unconfirmable 8th plate: a documented, known limitation of this
specific footage/OCR combination, not an open bug in the confirmation
or tracking logic (both are now cleared with direct evidence). If a
correct alert for this plate matters for the demo, the realistic paths
are: (1) accept the current alert's plate string is wrong for this one
vehicle and note it as a known gap, (2) manually correct/flag this one
plate in the watchlist data if it's a real vehicle of interest, or (3)
scope real OCR-accuracy work (fine-tuning or ensembling) as its own
dedicated, benchmarked effort -- not something to start unattended
this deep into an overnight run.

## Next

No further currently-actionable items identified for Priority 1 or 2 --
this branch is in a stable, fully-benchmarked state: Priority 0 (new
`/detections` contract) and the two original priorities (multi-vehicle
detection, motion blur) are done and kept, and the one remaining named
problem (`DL52GD0882`) now has a conclusive, evidence-backed diagnosis
rather than an open question. Nothing left that meets this branch's
own bar for a safe, well-evidenced, unattended change.

---

# Session 17 -- `plate_region_crop()` crop-band widened (branch `feature/plate-region-detector`)

Branch: `feature/plate-region-detector` (created from `main` @ `7e4a823`,
which already has the `anpr/` package refactor -- Sessions 1-16's logic
lives there now, reorganized into `anpr/{config,detection,ocr,
enhancement,tracking,plate_format,watchlist_client,streaming}.py` behind
a `detect_plate.py` re-export shim; verified line-for-line identical to
this branch's own prior logic when that refactor first showed up).

Not a scheduled Priority 1/2 firing -- a direct, scoped fix request for
a bug diagnosed live, in conversation, against two independent real
datasets: Dhruv's Tailscale training-camera RTSP feeds and a Sentinel
Gujarat/Kaggle CCTV dataset. Both are elevated, angled camera views --
structurally different from the close, level, forward-facing dashcam
footage `plate_region_crop()`'s band was originally tuned against.

## Root cause, confirmed before touching code

`plate_region_crop()` crops a fixed band out of each vehicle box before
OCR: y 55-92% of the box's own height, x 12-90% of its width. On an
elevated/angled CCTV view, a vehicle's plate can sit lower in its own
box than a level dashcam view would put it -- confirmed directly on the
Sentinel Gujarat/Kaggle bus frame (`13067896_3840_2160_30fps`, ~t=11.2s,
largest vehicle ~12% of frame): drawing both the old (92%) and a wider
(98%) band directly on the crop showed the plate sitting **below** the
old line, inside the new one.

## Fix

Widened the bottom edge only, 92% -> 98%. Left top (55%) and both sides
(12-90%) alone -- neither diagnosed case implicated them, and this
project's discipline throughout has been to fix what's measured broken,
not everything that theoretically could be.

**Considered, and explicitly did NOT change:** whether `plate_region_crop`
should be a fallback tried only after a whole-crop OCR pass returns
nothing, instead of both always running and their results combined
(current behavior). Checked `_read_plate_from_box()`'s actual logic
before assuming this needed changing -- it's already a deliberate,
documented design decision (`"Kept additive (not a replacement) so a
mislocalized crop can't cost us a detection the whole-crop pass would
still have found"`), not an oversight. Switching to fallback-only would
be a real regression risk: it would mean any frame where the whole-crop
pass finds *something* (even something wrong) never gets a chance at the
region-crop pass finding the *correct* plate. Left this alone.

**Checked for interaction with the already-fixed overlay-band false
positive** (Session 3: a close/large vehicle box pulling in the
dashcam's own burned-in timestamp, misread as a sequence of
valid-shaped plates, e.g. `II22IS3507` -> `II22IS3508` -> ...). That
protection is a *frame*-relative clip on the vehicle box itself,
upstream of this function, in `_read_plate_from_box`
(`y2 = min(y2, int(raw_h * 0.92))`) -- frame coordinates, not vehicle-
crop coordinates. Widening `plate_region_crop`'s own band (a fraction of
the already-overlay-excluded `vehicle_img`'s height) only reaches back
into the overlay band for a vehicle box that already sits right at that
frame-relative boundary -- a narrow edge case already further
constrained by the aspect-ratio filter (`MIN/MAX_VEHICLE_BOX_ASPECT_RATIO`)
that rejects the classic full-width, bottom-pinned overlay-strip shape.
Not just reasoned about -- re-verified against the real
`dashcam_trimmed.mp4` regression below, scanning the confirmed set
specifically for anything sequential/timestamp-shaped. Nothing found.

## Tested directly against both real cases that surfaced this bug

**Sentinel Gujarat/Kaggle bus frame** (the case with the clearest
evidence): drew both the 92% and 98% band boundaries directly on the
vehicle crop. Confirmed geometrically: the plate sits below the old
line, inside the new one -- the widened band now actually contains the
plate. **But OCR on the widened band still returned `'DUNNY'` (0.64
conf) -- not the real plate text.** Correctly rejected by the existing
candidate filters regardless (5 characters, below the 6-character
fallback-tier floor, and no digit present). Honest result: the
crop-band bug is real and now fixed geometrically on this frame, but
that alone does not recover a legible read here -- consistent with the
diagnostic conversation's own conclusion that the crop band was *a*
contributing factor on this footage, not *the* limiting factor. The
underlying image quality (20fps re-encode, motion blur, compression) is
still the ceiling.

**Tailscale training-camera frame (camera 222)** -- re-examined more
carefully this session, and correcting an earlier imprecise
characterization: drawing both band boundaries directly on this crop
showed the plate was **already fully inside both the old and new
bands** -- it was never actually being clipped by the 92% cutoff. The
"plate sat right at the cutoff" description from the earlier diagnostic
conversation doesn't hold up under direct re-inspection with the actual
boundary drawn; that was an eyeballing error, corrected here rather than
left standing. This fix doesn't apply to this specific frame's failure
mode, which -- like the bus -- looks like a resolution/OCR-engine limit
the crop band can't address. Flagging this correction explicitly rather
than quietly reporting only the case that worked in the fix's favor.

## Full regression

- **Static images:** 3/3, unchanged (`MH48AW4023`, `HR20AG3739`,
  `MH20DV2366`), via `tests/test_pipeline_smoke.py`.
- **Degraded set:** `lowlight` 3/3, `motionblur` 1/3, `glare` 3/3, `fog`
  3/3 -- all identical to the established baseline.
- **Dashcam video:** confirmed set is `{HR26EO6477, OL52OO0882,
  RJ45OK2913, HR98E4959, HR38AC7748, DL52GD4935, UP16DN8010, UP16ON8010,
  OL52GO0882, FRJ45CK2913}` -- same 10 plates as the documented
  baseline except one already-known-unstable `DL52GD0882`-cluster
  variant (`OL52GO0882` here vs. `DL52OO0882` in the baseline doc).
  Every named hard-stop plate present and correct. Given this session's
  own change touches OCR-crop logic more directly than Session 15's did
  (which only touched the watchlist-POST layer), didn't just cite the
  old stash/rerun precedent -- re-ran it fresh: `git stash`ed this
  session's fix, reran the identical video on unchanged code, got the
  exact same `OL52GO0882` (not `DL52OO0882`) with the fix absent too.
  Confirms this is the same pre-existing nondeterminism already
  documented, not something this change introduced. `git stash pop`
  restored the fix afterward. No new or timestamp-shaped false positive
  anywhere in the confirmed set.
- `send_detection_to_watchlist()`: untouched -- confirmed via `git diff`
  on `anpr/watchlist_client.py` directly (empty), not just "didn't
  intend to."

### Verdict: **kept, with an honest limitation stated plainly**

The crop-band bug itself is real, confirmed on two independent
datasets, and now fixed -- geometrically verified, not just asserted,
by drawing the actual band boundaries on both real crops that surfaced
it. Zero regression across every benchmark, including a same-day fresh
stash/rerun proving the one observed dashcam-set difference is
pre-existing noise, not caused by this change. **But per the explicit
instruction to report honestly either way: this fix did not recover a
legible plate read on either of the two real frames that motivated it.**
One (camera 222) turned out not to be a crop-band case at all on closer
inspection. The other (the bus) is now geometrically correct but still
blocked by underlying image quality. This is worth keeping -- it
removes one real, confirmed source of clipped plates for whatever
frames it does help, and costs nothing measurable -- but it should not
be reported as "the fix" for either diagnosed dataset's low read rate.
`main` untouched. Nothing pushed or merged, per instructions.

## Next

If Sentinel Gujarat/Kaggle footage remains the actual demo target
despite its measured limitations (per the diagnostic conversation
preceding this session), the realistic next levers are the same ones
already named there: real OCR-accuracy work (fine-tuning or ensembling,
not a quick change) or accepting a lower read rate on that footage as a
known constraint. The crop-band fix here is a real, kept, but
supporting improvement, not a substitute for either.

---

# Session 18 -- first real validation against real Sentinel Gujarat CCTV footage (cam06 daylight, cam07 night), full 30-minute runs

Branch: `feature/plate-region-detector`, continuing directly from
Session 17. Not a scheduled Priority firing -- a direct validation/
tuning request against two real 30-minute Sentinel Gujarat recordings
(`cam06.mp4`, daylight, "Madhuram Bypass Road Fix-2"; `cam07.mp4`,
night/IR, "HERO SHOWROOM FIX-1"), explicitly to validate and tune the
existing pipeline, **not** to retrain any model weights -- two videos
with no prior labels is nowhere near enough data for that, and none
existed for either clip before this session.

## Step 1: ground truth, established the same way as Session 8

Sampled both videos across their full 30 minutes (not just the start),
pulled the largest/closest vehicle at each point, and read every plate
directly from the image -- not from the pipeline's own OCR output, to
avoid the same circularity risk Session 8 was built to break. Logged
genuinely illegible plates as unconfirmable rather than guessing.
Also checked multiple vehicles per frame where several were present
(not just the single largest), since that's what the full run actually
needs validating against.

**cam06:** 6 confirmed (2 with minor character-level uncertainty
flagged honestly), 5 unconfirmable, across 8 sample points spanning
2.5-28.5 minutes, including one real two-plates-in-one-frame case
(`GJ11BR2513` + `GJ11CL8225` in the same frame).

**cam07:** 7 confirmed (3 with minor uncertainty flagged), 5
unconfirmable, across sample points spanning 3-28.5 minutes. Getting
this took an extra step: a plain 2-minute-interval scan (matching
cam06's method) found **zero vehicles at 11 of 15 sample points** --
including one timestamp where a motorcycle was already visible by eye
in an earlier frame. Checked directly rather than assumed: raw YOLO on
that exact frame found 0 vehicle-class detections (2 "person"
detections only). Applying the pipeline's own `enhance_low_light()`
recovered one motorcycle detection -- but at only 0.7% of frame area,
which `MIN_VEHICLE_BOX_AREA_FRACTION` (3%) then filters out anyway. So
the low-light gate does engage and does help; it's just not the whole
story on this footage -- the same elevated/wide-angle-camera effect
already diagnosed on the Tailscale/Kaggle footage compounds with the
low-light condition. Re-sampled densely (every 20s, with the low-light
enhancement applied first) and got a much richer picture -- this
became the real methodology for cam07's ground truth.

## Step 2: full 30-minute runs, no sampling/intervals

`process_video_file()`, `process_every_n_frames=10` (this project's
standard interval, for comparability with every prior regression), run
to completion, no time-window breaks.

| | cam06 (daylight) | cam07 (night) |
|---|---|---|
| wall-clock | 3,821.6s (~64 min) | 6,777.9s (~113 min, ~1.8x cam06 -- the low-light gate engaging on nearly every frame is the likely driver) |
| confirmed events | 208 | 107 |
| pattern-match tier | 190 | 97 |
| fallback tier | 18 | 10 |
| distinct confirmed plates | 174 | 102 |

## Ground truth cross-check -- done with fuzzy matching (the pipeline's
own `_plate_similarity`), not eyeballed, and a real methodology
correction caught before scoring anything

My own ground-truth sampling scripts only applied an aspect-ratio
filter, not the pipeline's actual `MIN_VEHICLE_BOX_AREA_FRACTION`
(3%) floor. Two of cam06's 6 ground-truth plates were on boxes at
2.0% and 2.6% of frame at the moment sampled -- **below the real
floor**, so their absence from the confirmed set isn't a miss, it's
the same already-validated Session 7 exclusion working as intended.
Verified this wasn't a fluke by grepping the full log for any trace of
either plate: zero hits for one; the other case is discussed below
under cam07 since the same-shaped plate showed up there too.

### cam06 -- 4 fair, in-scope test cases

| ground truth | pipeline result | verdict |
|---|---|---|
| `GJ11BR2513` | exact match | correct |
| `GJ11CL8225` | exact match | correct |
| `GJ01HA7952` | `GJ01HM7952` (90% similarity) | re-examined the source crop at full res -- the character is genuinely ambiguous in this font (A/M), could honestly be read either way. Not counted as a pipeline error. |
| `GJ11CO3910`* | not found | inconclusive -- this ground-truth read was already flagged low-confidence before scoring, can't fault the pipeline against an uncertain reference |

**3/3 clean matches on unambiguous ground truth, 1 inconclusive (excluded, not counted either way).**

### cam07 -- the harder, more important case, investigated to actual root cause rather than left as a raw score

First pass (fuzzy-matching against the final confirmed set only) looked bad: 6 of 7 misses, only the one plate below the 3% floor (`GJ09BC6441`, matched anyway -- likely because the *pipeline* sampled a later, larger moment of the same vehicle than the single frame I happened to check). Rather than report that number, dug into every "miss" by grepping the full log's raw `[reading, frame N]` lines (not just confirmed events) around each ground-truth timestamp -- the same technique Session 16 used on `DL52GD0882` -- to find out whether the plate was never seen, misread, or seen-correctly-but-not-confirmed. These are three different problems with three different fixes, and lumping them into one "miss" would have been misleading.

| ground truth | what the raw log actually shows | real diagnosis |
|---|---|---|
| `GJ06BY3848` | raw reading at frame 4490: **`GJ06BY3848`, 1.0 confidence** -- exact match to ground truth | OCR read it correctly. It never reached `confirm_threshold` (2 matching readings) before the track was lost -- a **confirmation/tracking-persistence** miss, not an OCR miss. |
| `GJ11CO9088` | raw readings at frames 24710-24760: `GJ11CO9000`, `GJ11CQ9008`, `GJ11CO9000`, `GB11OO0088`, **`GJ11CO9088` at 0.99 conf (exact match)**, `GJ11CQ9088` -- the correct string was read, once, at high confidence | The confirmed output (`GJ11CO9281`) is a *different* string than any of these -- the confidence-weighted majority vote converged on a variant that beat the single correct high-confidence reading by sheer repetition. **This is the same `DL52GD0882`-class majority-vote bias already diagnosed in Sessions 8/11/16**, now independently confirmed on real Sentinel Gujarat footage, not just the earlier dashcam clip. Same conclusion applies: not a tunable threshold, a real OCR-accuracy-vs-majority-count tradeoff already investigated and correctly left alone. |
| `GJ11AS7204` | raw readings at frames 31510-31530: **`GJ11AS9294`, repeated 3x, 0.93-0.99 confidence, fully consistent** | No trace of `7204` anywhere nearby. Given how consistent and confident the pipeline's read is, this looks more like **my own ground-truth read was wrong** (already flagged as "moderate, one digit ambiguous" before scoring) than a pipeline error. Not counted as a miss. |
| `GJ18Z8601` | nothing resembling `8601`/`Z860` anywhere in the frame window -- only unrelated plates and two `SAT21251[89]` fallback-tier reads nearby | Genuine, unexplained miss on a large (20.9%), clear vehicle. `SAT212518`/`SAT212519` are very plausibly misreads of cam07's own date overlay ("13-06-2026 **Sat** 21:..."), not the bus's plate -- see overlay finding below, but doesn't explain why the real plate itself wasn't read. Left as an honest open miss, not explained away. |
| `GJ02X0419` | raw readings nearby consistently show `GJ32K0419`, not `GJ02X0419` | This ground-truth read came from the *second-largest* box in a multi-vehicle frame (Step 2's earlier multi-vehicle check) -- with several vehicles in frame and no persistent ID linking my one-off diagnostic script's box-ordering to the real pipeline's continuous tracking, this is more likely **my own methodology attributing the reading to the wrong vehicle** than a pipeline misread of the same one. Excluded, not counted as a miss. |
| `GJ36RQ0180`* | raw readings nearby consistently show `GJ36AR0180`, repeated, 0.95-0.99 confidence | Same shape as `GJ11AS7204` -- my own ground truth was already flagged uncertain on this exact character, and the pipeline's consistent, confident read is plausibly the correct one. Not counted as a miss. |
| `GJ09BC6441` | (already discussed) | exact match, bonus case below the floor |

**Real tally for cam07, after investigation, not the raw fuzzy-match score:** of 7 ground-truth plates, 1 exact match, 3 recategorized as "ground truth likely wrong or unverifiable, not a fair test" (excluded), and 3 genuine misses -- but of those 3, **2 were confirmation/tracking-layer failures on correctly-read OCR, not OCR failures**, and 1 is a real unexplained miss. **Zero of the investigated misses were "the OCR genuinely couldn't read the plate."**

## Step 3: night-video failure mode -- checked, not assumed

Per the brief's own three options: (a) low-light gate not engaging --
checked directly, it does engage and does help (recovers detections
the raw frame doesn't have); (b) genuine below-floor image quality --
partially true (the elevated-camera-angle area-floor interaction
carries over from the Tailscale/Kaggle diagnostic), but the deeper
investigation above shows this **is not the dominant failure mode** on
the cases actually checked; (c) something new -- yes, something new,
and it's specific: **on this footage, when OCR reads the correct
plate, the confirmation/tracking layer's own logic (vote-threshold
timing, majority-vote character bias) is a more frequent point of
failure than OCR accuracy itself.** This is a genuinely different,
more precise diagnosis than "night footage is harder" -- it says
*where* in the pipeline the accuracy is actually being lost.

## Step 4: is anything here genuinely tunable?

No new code change made this session. The two real confirmation-layer
failure modes found (`GJ06BY3848`'s track-loss-before-threshold,
`GJ11CO9088`'s majority-vote bias) are the same class of issue as
`DL52GD0882`, already investigated three times (Sessions 8, 11, 16)
and correctly left alone each time -- Session 16 proved with hard
per-character vote-tally evidence that no confirmation-layer tuning
can fix a majority-vote bias when the wrong reading is genuinely more
frequent in the raw OCR output. That evidence generalizes here; not
re-litigating it with a narrower dataset.

One real, narrow, separately-scoped candidate did surface: the overlay
false-positive finding just below is structurally identical to
Session 3's dashcam-timestamp fix, just at a different frame position
(top, not bottom) -- a plausible, narrow, generalizable fix, but a
**different bug from the night-video accuracy question Step 3 was
scoped to**, and this session is already substantial. Flagging it as
the clear next candidate rather than folding it in here.

## A real new finding, on both cameras: overlay-text false positives (fallback tier only)

**cam06:** 4 of 18 fallback-tier confirms (`ADFIX2`, `DFIX2H`,
`AFIX2EF`, `DFX2FR`, all within seconds of each other early in the
run) are misreads of cam06's own location overlay ("Madhuram Bypass
Road **Fix-2**..."). Also found 2 likely track-fragmentation
duplicates of already-correctly-confirmed plates (`GJ0JJR1036`/
`GJ0JME2399` closely match confirmed `GJ03JR1036`/`GJ03ME2399` -- 0/O-
vs-3 misreads of the same real vehicles, not independent errors).

**cam07:** `SAT212518`/`SAT212519` (fallback tier, near the `GJ18Z8601`
miss above) plausibly misread cam07's date overlay ("13-06-2026
**Sat** 21:..."), not a vehicle plate.

Both are the same root cause as Session 3's original dashcam-timestamp
false positive: the existing overlay protection
(`_read_plate_from_box`'s `y2 = min(y2, int(raw_h * 0.92))`) only
clips the *bottom* of frame. These Sentinel Gujarat cameras burn their
overlays into the *top* -- a position the existing fix doesn't cover
at all. All instances found were fallback tier only (never sent to
`send_detection_to_watchlist()` in the real streaming path, which
gates on `note == "ok - pattern match"`), so no false watchlist alert
would have fired from this specific set -- but it's a real, generalizable
gap worth a dedicated top-band clip fix, structurally identical to the
existing bottom-band one.

## Honest accuracy summary, as requested

**cam06 (daylight):** 208 confirmed events, 174 distinct plates.
Ground truth: **3/3 clean matches on unambiguous, in-scope test
cases** (2 more excluded as below the detection floor by design, 1
excluded as inconclusive-on-both-sides). Small sample -- 3 or 4 data
points is not a statistically solid number, stated plainly rather than
dressed up.

**cam07 (night):** 107 confirmed events, 102 distinct plates. Ground
truth: **1 exact match**, **3 genuine misses** (of which 2 are
confirmation-layer failures on correctly-read OCR, not OCR failures,
and 1 is unexplained), **3 excluded** as more likely ground-truth
errors or methodology artifacts than pipeline errors. On the cases
actually verifiable, **zero were "OCR couldn't read the plate"** --
every real failure was downstream of a correct OCR read.

`send_detection_to_watchlist()`: untouched -- this session ran
`process_video_file()` only, which doesn't call it at all.

### Verdict: **no code change this session -- validation and root-cause diagnosis, not a fix**

This is exactly the outcome the brief's own Step 4 condition allows
for: nothing found here met the bar for a safe, narrow, tunable fix to
the actual question asked (night-video accuracy). What this session
delivered instead is more valuable than a forced fix would have been:
a real accuracy baseline on real footage (first time this project has
had one), and a precise diagnosis of *where* accuracy is actually
being lost on this footage (confirmation/tracking layer, not OCR) --
which changes what "improve accuracy" should even mean for this
dataset going forward. `main` untouched. Nothing pushed or merged, per
instructions.

## Next

1. **Overlay top-band clip** (cam06 + cam07's shared finding) -- the
   clearest, narrowest, most generalizable candidate fix identified
   this session. Structurally identical to the existing bottom-band
   fix (Session 3). Not implemented this session per Step 4's own
   scoping -- a separate, well-defined next step.
2. `GJ18Z8601`'s unexplained miss -- worth a closer look specifically
   (why did a large, clear plate produce zero matching reads anywhere
   nearby?) before assuming it's the same class of issue as the other
   cases.
3. The confirmation-layer failure modes found here (early track loss,
   majority-vote bias) are not narrow/tunable per Session 16's own
   hard evidence -- any real fix needs the same kind of dedicated,
   carefully-scoped session already called for repeatedly, not another
   quick pass.

---

# Session 19 -- expanded ground truth (37 usable test cases, up from 11), real accuracy is lower than Session 18's small sample suggested

Direct follow-up to Session 19's request: Session 18's accuracy numbers
were based on 6-7 eyeballed plates per camera -- honest about the
sample size at the time, but too small to trust as *the* accuracy
number. This session repeated the same eyeball-then-cross-reference
methodology at much larger scale: sampled both videos broadly (cam06:
every 30s across the full 30 min; cam07: every 15s, both with the
pipeline's own low-light gate applied first this time), pulled the
top 1-2 in-scope vehicle boxes per sample (applying
`MIN_VEHICLE_BOX_AREA_FRACTION` this time -- Session 18 found its own
ground-truth sampling had skipped this filter, which is why two
Session 18 "misses" turned out to be below-floor exclusions, not real
failures; not repeating that mistake here), and read every plate
directly, logging genuinely illegible ones as unconfirmable rather
than guessing.

## What this actually cost, honestly

68 candidate crops eyeballed this session (42 cam06, 26 cam07).
**Real, unfiltered legibility rate on this footage: about 44%** (30 of
68 produced a confident read; the rest were roof/side views, plates
cut off by the crop edge, or genuinely too blurred even to my own eye)
-- this alone is a useful, honest number Session 18's cherry-picked-
feeling samples didn't surface clearly. Combined with Session 18's
original 13, total ground truth across both sessions: 43 plates, of
which 37 are usable, well-defined test cases (a handful excluded as
below the detection floor or as ground-truth-uncertain-on-both-sides,
same standard as Session 18).

## Cross-referenced against the actual full-run confirmed sets (same fuzzy-matching method, `_plate_similarity`)

| | exact | close (>=85%, same plate + 1 OCR-ambiguous char) | miss | total |
|---|---|---|---|---|
| cam06 | 12 | 2 | 7 | 21 |
| cam07 | 6 | 2 | 8 | 16 |
| **combined** | **18** | **4** | **15** | **37** |

**Accuracy: 48.6% counting only exact matches, 59.5% if "close" (a
single OCR-ambiguous character, e.g. an O/0 confusion) counts as
correct.** Reporting both rather than picking whichever number looks
better -- exact-match is the stricter, more honest bar for something
that has to key a real watchlist alert; "close" is a reasonable
secondary number since several of these ambiguous characters are
genuinely hard to call even by eye (same class of ambiguity as
Session 18's `GJ01HA7952`/`GJ01HM7952`).

**This is meaningfully lower than Session 18's small-sample read**
(which looked like ~75% on cam06's tiny in-scope set). Not a
contradiction -- the small sample was an honest snapshot of too few
points, and this session's much larger, less cherry-picked sample is
the more trustworthy number. Exactly the outcome larger samples are
supposed to produce: a less optimistic, more representative picture.

## One direct consistency check, not just a bigger pile of numbers

`GJ18Z8601` (the Gujarat ST bus, Session 18's one "genuine unexplained
miss") was independently re-sampled this session at a different
timestamp (t=25.42min, a different approach of the same physical bus)
and **missed again** -- same result, sampled completely independently.
This upgrades it from "one unexplained miss" to "a reproducible miss on
this specific real vehicle," worth flagging as a stronger, more
trustworthy finding than a single data point could support.

## Spot-checked 3 of the 15 new misses against the raw log -- honestly mixed, not uniform

Didn't just assert Session 18's categories still apply -- checked
directly, and the result is more mixed than expected:

- `GJ24X9367` (cam07): raw log shows `GJ24Y9367` read at 0.98
  confidence nearby (a single-character X/Y OCR slip) -- but that
  reading never reached `confirm_threshold` before the vehicle left
  range. Same track-confirmation-timing pattern as Session 18's
  `GJ06BY3848`.
- `GJ07TY4975` (cam06): **zero trace anywhere** in the raw log near
  this timestamp -- not a misread, a real non-detection. A different
  failure mode from anything Session 18 characterized (that session's
  misses all had at least one raw reading somewhere nearby).
- `GJ32AA6163` (cam07): nearest raw reading is `'ESE3VZERO'` (fallback
  tier, 0.49 confidence) -- unrelated garbage, not a near-miss of the
  real plate. A genuine OCR failure on this specific frame/angle, not
  a confirmation-layer issue.

So this session's misses are **not** all the same previously-diagnosed
mechanism -- at minimum a real non-detection case exists alongside the
already-known confirmation-timing and majority-vote patterns. Flagging
this rather than the tidier (and wrong) claim that everything reduces
to Session 18's categories. A full investigation of all 15 misses
would be needed to know the real mix -- not done this session, scope
was the larger ground-truth sample itself.

## No code change

Same reasoning as Session 18: the failure modes reproduced/confirmed
here are the already-investigated confirmation-layer issues (Sessions
8/11/16/18), not something a narrow parameter tune can fix. `main`
untouched. Nothing pushed or merged.

### Verdict: **honest, larger-sample accuracy number delivered -- ~49-60% depending on strictness, real and lower than the earlier estimate, not softened**

This is the number that should be quoted going forward for this
footage, not Session 18's 6-7-plate estimate. 37 usable test cases is
still not a huge sample for a hackathon-scale validation, but it's
3.4x Session 18's and was gathered with the corrected methodology
(pipeline's real area floor applied to ground-truth sampling too).

---

# Session 20 -- accuracy-improvement bake-off (4 candidates benchmarked, 3 rejected, 1 built: a BLPR-style local-VLM last-resort fallback)

Branch: `feature/plate-region-detector`, continuing directly from Session
19. Direct follow-up to an explicit user request: two AI-generated
analyses proposing ways to improve accuracy (the current pipeline is
tuned for speed, per Session 4-era YOLOv8n choice) were pasted in and I
was asked to evaluate and test what was actually feasible.
**Explicit constraint for this whole session: do not commit or push
anything until told to**, specifically so the user could discard any
underperforming experiment and keep `main`'s existing pipeline intact.
That constraint held for the entire session -- everything below was
tested locally; nothing was committed until this write-up, and even this
write-up is not yet pushed.

Ground truth used throughout: the same 41 unique real Sentinel Gujarat
plates from Sessions 18+19 (Session 19's 30 plus Session 18's original
13, one overlap on `GJ18Z8601`), cross-referenced via the pipeline's own
`_plate_similarity` fuzzy match, same methodology as prior sessions.

## Candidate 1: swap the plate-region heuristic for a pretrained detector (`open-image-models`, YOLOv9)

Tested in an isolated venv (never touched the real `ml-anpr/venv`),
`yolo-v9-s-608-license-plate-end2end`. Localization was genuinely strong
(29/30, then 13/13 on the second batch, found a real plate box), but
feeding its *tight* box straight into the existing OCR call did worse
than the current heuristic crop band: 40% usable vs. the baseline's
59.5%. Checked why rather than assuming: raw OCR output on the tight
crops was real garbage (`GJ11CD8889` -> `691108885`) despite the crops
being clean and human-legible -- the tight crop, not image quality, was
the bottleneck.

Swept padding around the detected box (0/20/30/35/50/70%): accuracy
peaked at 30-40% padding, non-monotonically -- 35% gave 63.3% usable on
Session 19's 30 plates, beating the baseline. But re-run on Session 18's
original 13 (the harder, previously-diagnosed cases), the same 35%-pad
setup only hit 38.5%. On the exact 7 cases Session 18 itself counted as
fair/in-scope, new-detector-plus-padding scored 3 exact/0 close/4 miss
(42.9%) vs. the old pipeline's 3/1/3 (57.1%) -- worse on the specific
cases already known to be hard, including still missing `GJ18Z8601`.

**Verdict: not a clean win, inconsistent across sample sets -- rejected.**

## Candidate 2: swap the vehicle detector (YOLOv8n -> YOLO26n)

Real, current Ultralytics model (confirmed via the actual downloaded
weights, not assumed). Ran both models on the same 30 saved raw frames
from Sessions 18/19's cam06/cam07 sampling, same vehicle-class filter and
area/aspect thresholds, so this isolates the architecture with nothing
else changing.

cam06 (daylight): YOLOv8n found 49 vehicle-detections across 15 frames,
YOLO26n found 32 (-35%) -- lost vehicles entirely at 2 timestamps
YOLOv8n caught, and undercounted badly on busy frames (6 motorcycles
found by v8n at t=16.5min vs. 1 by 26n -- verified this wasn't a
class-mapping bug by dumping raw class/confidence output directly, both
models share the same COCO class scheme).

cam07 (night): YOLO26n found 3x more raw detections, but nearly all
were 0.1-1.6% of frame area -- still below `MIN_VEHICLE_BOX_AREA_FRACTION`
(3%), so they'd never reach OCR anyway. Net new *usable* detections:
effectively zero.

**Verdict: real daylight recall regression for a night-time gain that
mostly doesn't clear the existing area floor -- rejected (nano variant
only; a larger YOLO26 might trade differently, not tested).**

## Candidate 3: Indian_LPR end-to-end (FCOS detector + LPRNet OCR, pretrained weights)

Confirmed again (same finding as this project's earlier research): the
raw training dataset still isn't publicly downloadable, but the
pretrained weights genuinely are, checked into their GitHub repo
(`best_od.pth`, `best_lprnet.pth`) -- verified real by running their own
demo image first (correctly read a genuine Gujarat plate) before
touching any of our data. Patched one line of *their* code (`np.int`,
removed in modern NumPy) inside the isolated clone only -- not our repo.

Ran their real `run_single_frame()` end-to-end pipeline on all 41 ground
truth plates: **4 exact + 6 close + 31 miss = 24.4% usable.** Gets exact
reads on the same clean crops every method handles fine, falls apart on
anything more marginal (`GJ01WW5208` -> `BAC7C2A87940`) -- a clear
out-of-distribution problem, their model never saw this camera/angle/
resolution profile during training. No LICENSE file in their repo either
(fine for local benchmarking, would need clarifying before any real use
-- moot given the accuracy).

**Verdict: not viable for this footage -- rejected.**

## Candidate 4: `fast-plate-ocr` (OCR-only swap, keep our own detection/crop stage)

The one candidate that isolates the OCR stage specifically, rather than
detection or the whole pipeline -- run on our own production heuristic
crop (`plate_region_crop()`) at first, which gave near-total empty output
(39/41) that turned out to be two real integration bugs, not an accuracy
signal, caught before scoring anything: (1) fed it BGR when the
`cct-s-v2-global-model` config declares `image_color_mode='rgb'`, and
(2) — the bigger one — this library expects a *tight* plate-only crop
(64x128 or 70x140, no aspect-ratio preservation), not the loose
vehicle-region band our heuristic produces; the loose crop squishes the
actual plate text into a tiny fraction of the resized input regardless
of color channels.

Re-ran correctly: same `open-image-models` + 35%-pad tight crops from
Candidate 1, correct color mode per model (`cct-s-v2-global-model` wants
RGB, `global-plates-mobile-vit-v2-model` wants grayscale -- confirmed via
`m.config.image_color_mode`, not guessed). Also worth noting: neither
model's `plate_regions` list includes India (confirmed by reading the
loaded config directly), despite claiming 65+-country coverage.

- `cct-s-v2-global-model`: 2 exact + 6 close + 33 miss = **19.5% usable**
- `global-plates-mobile-vit-v2-model`: 0 exact + 0 close + 41 miss =
  **0.0% usable** (also hit a CoreML execution-provider crash on the
  original run, worked once forced onto `CPUExecutionProvider`)

Both clearly worse than the existing PaddleOCR call on the *same* crops
that scored 63.3%/38.5% with PaddleOCR -- the existing OCR engine is
simply the stronger part of the stack here, not the bottleneck.

**Verdict: clear no on both variants -- rejected.**

## Candidate 5 (not from the original two analyses -- proposed after the above 4 all came back negative): BLPR-style confidence-gated local-VLM fallback

Before testing anything, I directly read the images for the 18 unique
plates every method above still missed (the same-shaped test this
project's ground-truth-gathering has always used, applied here to
diagnose a fix candidate instead) -- and found most were genuinely
legible to a competent reader, including `GJ18Z8601`, Session 18's one
"genuine unexplained miss" that the raw OCR log never found any trace
of. That's a strong, independent sign the bottleneck for these specific
cases is reading capability, not image quality -- worth testing with an
actual small model rather than my own (much larger, not representative)
read.

**Installed Ollama + `gemma3:4b`** (Google's small open-source vision
model, 3.3GB) locally on this machine -- explicitly the same
model class BLPR's own paper uses. Runs entirely on-device: no image or
plate data leaves the machine, no third-party API, no account. Measured
real latency before designing anything: **0.48s warm, 6.7s cold**
(model not resident in memory) -- this is why the integration below
dispatches the call in a background thread rather than inline in the
per-frame loop.

### First result had a real bug, caught before it shipped

Initial test on the 18 hard misses, direct "read the plate" prompt:
**1 exact + 5 close + 12 miss = 33.3% usable.** Looked like a strong
result. But wiring it into the real pipeline and running the existing
`dashcam_trimmed.mp4` regression clip surfaced something worse: on
crops with genuinely no plate visible at all (e.g. a bus's side-profile
door, no plate anywhere in frame), the model confidently invented a
realistic-looking but entirely fake plate number instead of declining --
7 different fabricated plates on 7 such crops in one run, all passing
the pattern-format validation since they *looked* like valid Indian
plates structurally. Caught this by tracing which actual image bytes
were sent for each call and looking directly at the one that produced
`HP32A4567` -- confirmed it really was a plate-less bus-door photo, not
a bug in the crop pipeline.

**Fix:** rewrote the prompt to force an explicit two-step judgment
("is a plate visible at all -- YES/NO -- before any text extraction",
stated plainly that "no plate visible" is a common, fully expected
answer) instead of a direct read request. Re-tested against the same 7
previously-hallucinated crops: all 7 now correctly say no plate visible.
Re-ran the full `dashcam_trimmed.mp4` regression: **zero** fake
VLM-fallback confirmations (down from up to 7), and `HR98E4959` still
confirmed exactly as it always has, completely untouched.

Re-tested the 18 hard-miss set with the fixed prompt: **2 exact + 1
close + 15 miss = 16.7% usable** -- lower than the unsafe prompt's
33.3%, which is the expected, correct tradeoff: fewer rescues, but no
more fabricated plates. Projected effect on the combined 41-plate set:
roughly 58.5% -> 65.9% usable (vs. an earlier, now-superseded estimate
of ~73% based on the unsafe prompt -- that number should not be quoted
going forward, this one should).

### What got built (real code, not committed)

- `anpr/vlm_fallback.py` (new): calls the local Ollama API with the
  two-step prompt, validates the response through the exact same
  `INDIAN_PLATE_PATTERN`/`_correct_plate_positions` logic every other OCR
  reading already goes through -- never trusts the model's raw text
  directly. Fails closed (returns `None`) on any Ollama connection
  problem, malformed response, or failed validation; never raises into
  the caller.
- `anpr/tracking.py` (`VehicleTracker`): caches each track's
  largest-area vehicle crop over its life (not highest-OCR-confidence --
  that would exclude exactly the zero-OCR-candidate cases most worth
  rescuing). Fires the fallback **exactly once per track, only at the
  frame it's about to be pruned (`missed == MAX_MISSED_FRAMES`) and only
  if that track's own `PlateConfirmationTracker` never confirmed
  anything.** This is the key safety property: a track that already
  confirmed normally (any long clean run, `HR98E4959`-shaped or
  otherwise) never reaches this condition at all, so the fallback cannot
  touch, regress, or interact with anything already working. Dispatched
  via `ThreadPoolExecutor` (stdlib, no new dependency) since the measured
  latency is too slow to block the per-frame loop; results collected via
  a new `pop_ready_vlm_confirmations()` polled once per frame, kept
  fully separate from `PlateConfirmationTracker`'s own vote (Session 16
  already proved hard that majority-vote bias isn't fixable by weight
  tuning -- adding a single high-weight VLM vote into that mechanism
  risks creating a new version of the same problem, not fixing it).
  Confirmed events from this path carry a distinct
  `note == "ok - vlm fallback"`, never `"ok - pattern match"`, so they
  stay visibly separate from normal OCR confirmations in logs/stats and
  do **not** reach `send_detection_to_watchlist`'s existing
  `note == "ok - pattern match"` gate by default -- a single
  uncorroborated VLM read alerting a real watchlist match felt like the
  wrong default risk tradeoff; this is flagged as an explicit decision,
  not a silent gap, in case that default should change later.
- `anpr/streaming.py`: `raw_frame` threaded into all three
  `tracker.update()` call sites (backward compatible -- other callers
  like `vehicle_trace_demo.py` and the two `benchmarks/` scripts that
  call `VehicleTracker.update()`/`detect_plate_from_frame()` directly are
  unaffected, since `raw_frame` defaults to `None` and
  `detect_plate_from_frame`'s own signature was deliberately left
  untouched to avoid a wide blast radius across those other callers).
  `process_video_file` also gets a bounded drain step
  (`concurrent.futures.wait(..., timeout=25)`) after the video ends, so
  a fallback call still running on the last few frames isn't silently
  dropped from the final confirmed-plates summary.

### Verification done before considering this safe to write up

1. Full `dashcam_trimmed.mp4` regression, twice (before and after the
   prompt fix) -- `HR98E4959` confirmed correctly both times, exactly as
   every prior session's regression has shown; zero fallback
   interference either time.
2. Direct code-path test (not just isolated prompt calls): simulated a
   track fed the real `GJ18Z8601` crop with `plate_number: None` for its
   whole visible life (matching the real case -- Session 18's raw log
   had zero trace of this plate), stepped it through `MAX_MISSED_FRAMES`
   missed updates, confirmed the fallback dispatches on exactly the 5th
   missed frame (not before), and correctly returns
   `{'plate_number': 'GJ18Z8601', 'confidence': 0.5, 'note': 'ok - vlm
   fallback'}` after the background call completes.
3. Practical mitigation noted but not yet applied: Ollama's
   `keep_alive=-1` (already set in `vlm_fallback.py`'s request payload)
   keeps the model resident so the 6.7s cold-start essentially never
   recurs in practice, at the cost of ~3.3GB RAM held permanently.

### Not yet done

- No test against a real, full Sentinel Gujarat video run with this
  wired in -- only the isolated 18-crop set and the dashcam regression
  clip. The projected 58.5% -> 65.9% combined-accuracy effect is exactly
  that, a projection from the 18-crop test, not a measured full-video
  number.
- No decision made on whether `send_detection_to_watchlist` should ever
  accept `"ok - vlm fallback"` events -- left at today's default (no),
  explicitly flagged above as the user's call, not decided silently.
- `anpr/streaming.py`'s two live-stream loops (`process_stream`,
  `process_hls_stream`) got the same wiring for consistency but weren't
  separately regression-tested the way `process_video_file` was (no live
  RTSP/HLS source available to test against here).

### Verdict: **4 of 5 candidates rejected after real testing, 1 built and safety-verified but not yet measured on a full real video run.**

## Two more real findings this session, after real human ground truth surfaced a genuine pipeline bug

The user manually noted plates by eye from `dashcam_trimmed.mp4` (independent
of anything the pipeline or I produced) and cross-checked them directly
against the actual frames. Two of those checks turned up a real,
previously-only-suspected pipeline error:

- `DL52GD0882` (real plate, confirmed by directly viewing the frame --
  clearly "DL 52 GD 0882" on a green EV plate) vs. the pipeline's
  confirmed `DL52GO0882` -- **wrong**. This is the exact plate Sessions
  8/11/13/16 investigated four times without ever having real ground
  truth to confirm which reading was actually correct.
- `DL52GD4935` vs. pipeline's `DL52GO4935` -- same error, same pattern,
  different plate, also a green EV plate.
- (`HR9BE4959` vs. the pipeline's `HR98E4959`: checked too, pipeline was
  actually right here -- the user's note had a small transcription slip,
  "98" reading like "9B" in that font at a glance.)

### Fix 1: overlay-text top-band clip -- the Session 18 "next" item, done and verified

Session 18 found cam06/cam07 misreading their own burned-in
date/location overlay as plate-shaped text (`ADFIX2`/`DFIX2H`/etc. on
cam06, `SAT212518`/`SAT212519` on cam07), and flagged that the existing
overlay protection (`_read_plate_from_box`'s bottom-band clip,
`y2 = min(y2, int(raw_h * 0.92))`) only covers the *bottom* of frame --
these cameras burn their overlay into the *top* instead, a gap the
existing fix doesn't reach.

Measured the real overlay extent directly on saved cam06/cam07 frames
rather than guessing a number: on both cameras the overlay text sits
within the top ~5% of a 1080px frame. Added a symmetric top clip,
`y1 = max(y1, int(raw_h * 0.08))`, same reasoning as the bottom one
(real plates aren't mounted in a camera's own UI overlay band), 8%
giving real margin over the measured ~5%.

**Verified two ways, not just reasoned about:**
1. Re-ran `_read_plate_from_box` directly against the exact frames/boxes
   that produced `ADFIX2` (cam06, frame 140, box `(1314,3,1566,330)`)
   and `SAT212518` (cam07, frame 37950, box `(219,8,813,608)`) before
   this fix -- both now return `"Text found, none plate-shaped"`, the
   overlay text no longer survives into what gets read.
2. Full `dashcam_trimmed.mp4` regression re-run -- identical confirmed-
   plate set to before this change, `HR98E4959` unaffected. Dashcam's
   own overlay is bottom-only, so no interaction expected, and none
   found.

### Fix 2/3 investigated: `DL52GD0882`'s D->O misread and "confidently wrong" plates -- same root cause, real new evidence, still correctly left alone

Dug into the actual raw-reading history for `DL52GD0882` in
`dashcam_trimmed.mp4` (now with real ground truth to check against,
unlike Sessions 8/11/13/16 which never had it): OCR read `GD` correctly
3 times, including once at a perfect 1.0 confidence, but read `GO` 18
times across the same track's lifetime. `PlateConfirmationTracker`
confirms as soon as `confirm_threshold` (2) is reached and never
revisits a confirmed cluster -- so whichever variant happened to be
narrowly ahead in the first couple of readings locks in the answer,
regardless of what the majority of the full run would have said either
way.

This is the same majority-vote-bias mechanism Session 16 already proved
(with hard per-character vote-tally evidence) can't be fixed by tuning
the confirmation-layer's weights -- re-confirmed here with new, real
evidence (not just suspicion) rather than re-litigating it. Looked for a
genuinely different angle before giving up: checked whether the D/O
confusion correlates with vehicle distance/box size (would suggest a
resolution-driven, preprocessing-fixable cause) -- it doesn't cleanly;
a larger box at frame 885 still misread as `GO` at 1.0 confidence, while
a smaller box at frame 1095 correctly read `GD`. Looks like genuine
per-frame OCR noise rather than something a targeted image-preprocessing
fix could reliably correct.

**No code change made here** -- consistent with this project's own
established precedent (Sessions 11, 13: correctly stopping rather than
forcing a risky change to code every confirmed plate depends on, when no
safe fix was actually found). One real candidate for future work,
explicitly not started today: teach the system to notice when its own
vote was a close call and route *those* specific cases through the VLM
fallback as a tie-breaker, instead of only using the fallback for tracks
that never confirmed at all. That's a distinct, bigger design task (needs
`PlateConfirmationTracker` to expose vote margins, which it doesn't
today) -- flagged, not attempted.

## Backend integration wired up this session (separate from the accuracy work above)

Real API details arrived from P6 (backend) mid-session: real
`X-Internal-Key`, real `DETECTION_API_URL`, and (after a follow-up ask)
the real `camera_id` values for the 10 stable registered cameras,
independently re-confirmed by Dhruv (streaming) down to the physical
location behind each `direct-camNN` path.

- `anpr/config.py`: `DETECTION_API_URL` and `INTERNAL_KEY` updated to
  real values (were dev placeholders). `CAMERA_ID_MAP` replaced with the
  real `direct-cam01..10 -> 43..52` mapping; the old `livecam`/
  `camera1`/`camera16` placeholder entries were removed outright (not
  kept as a fallback) once P6 confirmed those point at a fictional demo
  camera and a nonexistent registry id respectively -- keeping them
  would have silently misreported real detections to the wrong/a
  nonexistent camera instead of just correctly not sending at all.
- Real, worth flagging: our own `cam07.mp4` test footage's burned-in
  overlay reads "HERO SHOWROOM FIX-1", matching `direct-cam07`'s
  confirmed real location ("Hero Showroom, Gir Somnath") -- independent
  evidence this test footage really is from a registered camera. But
  `cam06.mp4`'s overlay ("Madhuram Bypass Road Fix-2") does **not**
  match `direct-cam06`'s confirmed location ("Timbavadi Gate,
  Junagadh") -- flagged as a real discrepancy, not assumed to line up.
- `anpr/streaming.py`: `process_stream` and `process_hls_stream` (the
  two live-camera paths) previously only forwarded `"ok - pattern
  match"`-tier confirmations to `send_detection_to_watchlist`, silently
  dropping fallback-tier and VLM-fallback-tier confirmed reads entirely.
  The actual contract (confirmed directly with P6) asks for *every*
  confirmed plate read, since backend-watchlist itself decides
  server-side whether it's a watchlist hit -- client-side gating on note
  type was real, unintentional under-reporting. Fixed in both live
  paths; `process_video_file` intentionally left alone (it never called
  the backend at all -- that's correct, it's the offline test/regression
  path).
- **Still open, not resolved this session:** a live camera (`direct-cam06`,
  backend `camera_id: 48`, real Cloudflare-tunnelled HLS URL) is
  confirmed reachable, but `backend-watchlist` itself is not reachable
  from this development machine (`localhost:8001` -- backend runs on a
  different machine, also behind its own Cloudflare tunnel). A live
  end-to-end test (real camera -> real detection -> real backend POST)
  has not happened yet; blocked on getting a reachable tunnel URL for
  backend-watchlist from P6, same way Dhruv provided one for the camera
  feed. Nothing in this codebase calls `send_detection_to_watchlist`
  with a live/real `direct-camNN` source yet either -- that wiring is
  still a separate, open task.

Nothing pushed. This session's code changes committed locally on
`feature/plate-region-detector` per explicit go-ahead; not merged to
`main`.

---

# Session 21 -- P3 scalability handoff: separated pipeline, worker pool, async delivery, synthetic load test

Branch: `feature/plate-region-detector`, continuing directly from
Session 20. Direct response to a handoff from P3: make the ML detection
pipeline scalable independently of live video playback, with 10
specific numbered requirements and 5 pieces of required evidence.

New package `anpr/pipeline/` -- a separate layer alongside
`anpr/streaming.py`, not a replacement for it. The existing
`process_stream`/`process_video_file`/`process_hls_stream` (used
throughout Sessions 1-20 and already regression-tested against
`HR98E4959`) are untouched; this is a new, additive entry point for the
multi-camera/scalable case, built on top of the same underlying
`detect_plate_from_frame`/`VehicleTracker` logic, not a reimplementation
of it.

## Architecture: three independent stages connected by queues

1. **`frame_source.FrameReader`** (item 1, 2) -- one per camera, its own
   thread, configurable sampling rate (`sample_every_n`, same semantics
   as `process_video_file`'s existing `process_every_n_frames`). Pushes
   sampled frames onto a bounded queue instead of calling inference
   inline. Backpressure (item 7): a full queue means the newest frame is
   dropped, counted, not blocked on -- a live camera can't be paused,
   and blocking one reader would back up every camera sharing that
   downstream worker.

2. **`inference_worker.InferenceWorkerPool`** (item 3) -- N workers, one
   dedicated frame queue each. Cameras are hashed to a worker up front,
   not round-robined per frame -- `VehicleTracker` keeps per-camera
   frame-to-frame state (IoU matching, confirmation clusters) that isn't
   thread-safe and depends on in-order frames, so a camera's tracker
   must only ever be touched by one thread for its whole lifetime. This
   is real camera-level parallelism (N cameras spread across M workers),
   not frame-level -- documented as the honest scope of "distributed
   across workers" here.

3. **`event_sender.EventSenderPool`** (items 4, 6, 7, 8) -- multiple
   senders draining one shared event queue (no per-camera pinning needed
   here, unlike inference -- any sender can deliver any event safely).
   Batches up to `batch_size` events or `batch_timeout_sec`, whichever
   first, and sends each with retry + exponential backoff. Backpressure
   here too: a full event queue means new events are dropped and
   counted, not blocked on.

`events.DetectionEvent` (item 5): every event carries `event_id`,
`camera_id`, `timestamp`, `model_version`, `confidence`, and
`detection_type`. Honest caveat, not glossed over: real
backend-watchlist's `POST /detections` contract only documents
`{camera_id, plate_number, confidence}` -- the extra fields are sent as
additional JSON fields (most REST frameworks ignore fields they don't
recognize) so the richer schema is already in place if the contract
gets extended, but whether the backend actually stores/uses them today
is unconfirmed, not claimed as done.

`metrics.Metrics` (item 9): thread-safe counters/latency-sample deques
for frames read/dropped/processed, inference throughput, events
produced/sent/failed/retried/dropped, event throughput, avg/p95 send and
inference latency, and live queue depth. One `snapshot()` call gives a
single consistent read across every stage.

## The item 6 gap, stated plainly rather than papered over

"Retry failed deliveries safely without creating duplicate detections"
can only be a **best-effort client-side guarantee** against the real
contract as it exists today -- `POST /detections` has no client-supplied
idempotency key (its only server-side dedup is for scripted *replay*
scenarios keyed on `scenario_run_id`+`camera_id`+`plate_number`, not for
retrying an arbitrary live detection). What's actually implemented: a
clean connection failure is always safely retried (request definitely
never arrived); a timeout is retried too on the judgment that losing a
real detection is worse than an occasional duplicate row for a
security-alert pipeline -- a real, deliberate tradeoff, not a guarantee;
a local in-process "already confirmed sent" set (keyed on `event_id`)
stops resending something this client already got a real `201` for. A
genuine fix needs a server-side idempotency key in the contract --
flagged as a real ask for P6, not solved unilaterally here.

## Required evidence

**Real inference from the available sample streams:** ran the full
3-stage pipeline against `dashcam_trimmed.mp4` (`ScalablePipeline`,
1 camera, 2 workers, `sample_every_n=15`, 45s). Real, not mocked:
30 frames processed, 4 real confirmed-plate events produced from actual
`detect_plate_from_frame`/`VehicleTracker` output, all 4 delivered
successfully through the real `EventSenderPool` batching/retry logic
(dry-run send target, since backend-watchlist isn't reachable from this
dev machine -- see Session 20's backend-integration section). Separately
verified retry/backpressure against the real, currently-unreachable
`DETECTION_API_URL`: 2 retries with backoff, clean failure, accurate
metrics (`events_failed=1`, `events_retried=2`), no crash -- exactly the
required safe-degradation behavior.

**Synthetic detection-event load test (item 10):** `benchmarks/
synthetic_load_test.py`, fake metadata events for 1,000/10,000/80,000
camera identities, no video decode at all, run against a local mock
backend (`benchmarks/mock_backend_server.py`) since real
backend-watchlist isn't reachable from here right now -- explicitly
measures this pipeline's own delivery infrastructure, not the real
production backend's capacity, stated as such in the script's own
output.

**Maximum tested events per second / average and p95 latency:**
measured directly, not estimated -- a real, reproducible ceiling of
**~1,870-1,900 events/sec sustained** (8 sender threads, this machine's
hardware, against the mock backend), independent of camera-identity
count: 1,000/10,000/80,000 identities all sustain essentially the same
throughput once the target rate is at or above that ceiling, a clean
signal that this pipeline's delivery capacity is rate-bound, not
identity-count-bound. At that ceiling: avg latency ~1.2-4ms, p95
~2.7-5.7ms, 0 errors, 0 drops.

Found and fixed two real bottlenecks while measuring this, not assumed
away:
1. First measurement showed adding more sender threads barely moved
   achieved throughput (~1,200-1,300/s regardless of thread count) --
   traced to `requests.post()` opening a fresh TCP connection every
   call; switched to a persistent `requests.Session()` per sender for
   connection-pool reuse. Modest improvement (~1,300 -> ~1,400/s), not
   the fix alone.
2. Real bottleneck: the load generator and the mock backend were both
   running as threads inside the *same* Python process, meaning they
   competed for the same GIL -- not a limit on the pipeline's own
   design, an artifact of how the test was first set up. Running the
   mock backend as a genuinely separate OS process (matching how a real
   backend actually would be) raised throughput to the ~1,870-1,900/s
   figure above.

**Worker-scaling design:** camera-level horizontal scaling via
`InferenceWorkerPool` (stable hash of `camera_id` -> worker index, so
each camera's tracker state stays coherent on one thread) and
independent horizontal scaling of delivery via `EventSenderPool` (no
per-camera constraint, any sender can send any event). Both pools take
`num_workers`/`num_senders` as plain constructor arguments -- sizing
them for a real deployment is a hardware/ops decision, not hardcoded
here. Not exercised on this hardware: true multi-GPU distribution (this
Mac has one MPS device) -- the worker-pool structure is what that would
plug into (one model instance per worker, pinned to its own device), but
that specific extension is un-tested, stated as such rather than implied
as done.

## What's not done / open

- Not tested against a real, live camera feed end-to-end (needs a
  reachable backend-watchlist URL first -- see Session 20's still-open
  item on that).
- Multi-*process* worker distribution (vs. multi-*thread*, what's built)
  not implemented -- threads share this pipeline's already-loaded
  `anpr.config.yolo_model`/OCR clients cheaply, but true CPU-core
  parallelism for the CPU-bound parts of inference would need separate
  processes (GIL). Threads were the right first build for what item 3
  actually asked (distribute cameras across workers) and matches this
  session's demo-scope hardware (single Mac, one GPU); real multi-core/
  multi-GPU horizontal scaling is the natural next step once there's
  real hardware to test it against.
- The claim text P3 asked to be able to make ("NETRA separates video
  ingestion from AI inference and scales inference horizontally using
  independent workers. Synthetic load testing represents 80,000 camera
  identities, while real inference is demonstrated on the available
  video feeds.") is now backed by real, measured evidence above, not
  asserted without it.

Committed (`daf479f`); nothing pushed yet, per this project's
always-ask-before-push rule.

# Session 22 -- P6 closed the item-6 idempotency gap: `event_id` is now a real server-side dedup key, not just a client-side best-effort guard

Session 21 flagged one real gap in the scalability build and sent it to
P6 as a genuine ask: `EventSender`'s retry-on-timeout path (item 6)
could not guarantee no duplicate detections/alerts, because
backend-watchlist's `POST /detections` had no client-supplied
idempotency key -- only `scenario_run_id` dedup for scripted replays,
which doesn't apply to live retries.

P6's reply: `event_id` (UUID) is now accepted as an optional field on
`POST /detections` and is a real server-side idempotency key -- a
repeat POST with the same `event_id` is a no-op that returns the
original `detection` and `alert` instead of creating a second one of
either (the alert side specifically called out as handled, since a
duplicate *alert* was the case that actually mattered for the
downstream alerting flow, not just a duplicate detection row). Backed
by a partial unique index on `event_id`, mirroring the existing
`scenario_run_id` dedup pattern. Omitting `event_id` is a complete
no-op -- safe to roll out incrementally, no behavior change for any
caller not sending it.

Backend commit: `2cb1757` (`feat(backend-watchlist): add
client-supplied idempotency key to POST /detections`) on
`origin/feature/backend-watchlist` -- **confirmed via `git fetch` +
`git show`, not taken on faith** -- this branch is not yet merged to
`main`, so this guarantee only holds against a backend-watchlist
deployment that actually has this commit.

## What changed on our side: nothing functional, one stale limitation removed

Checked `anpr/pipeline/events.py` and `event_sender.py` against the
confirmed contract diff before touching anything:

- `DetectionEvent` (`events.py`) already generates a UUID `event_id`
  per event (`field(default_factory=lambda: str(uuid.uuid4()))`) and
  already sends it as `"event_id"` in every `to_backend_payload()` call
  -- field name matches the contract exactly, no payload change needed.
- `EventSender._send_with_retry()` (`event_sender.py`) already retries
  on both clean network failures and timeouts (`requests.exceptions.
  RequestException` covers both) -- this was Session 21's deliberate
  "retry on timeout too, accept the duplicate-row risk" tradeoff. That
  tradeoff is now backed by a real guarantee instead of being a risk,
  with no code change required to get it.

So the fix here was documentation only: both modules' docstrings
described item-6 duplicate-safety as "best-effort client-side only, not
a guarantee" -- now stale and actively misleading now that the server
side exists. Rewrote both docstrings to state the real current
guarantee, name the confirming commit, and flag the one real remaining
caveat (only holds once `2cb1757` is merged/deployed on whichever
backend a given run actually points at). The local
`_sent_event_ids` in-process set is kept as-is -- no longer
load-bearing for correctness, but still a legitimate fast local
short-circuit that avoids a redundant network round-trip.

## What's not done / open

- `2cb1757` is not yet on `main` -- if a real end-to-end test against
  backend-watchlist happens before it's merged, the old
  best-effort-only behavior (and the small duplicate-row risk on a
  retried timeout) still applies there. Worth confirming merge status
  before relying on this for a real demo.
- No real end-to-end retry-duplicate test run against a live
  backend-watchlist with `2cb1757` deployed -- confirmed by reading the
  contract commit directly, not by testing our own retry path against
  a real server (still unreachable from this dev machine, per Session
  20/21's open item).

# Session 23 -- first real live-stream test against P3's Docker/MediaMTX relay, found and fixed a real connection bug in `process_hls_stream()`

P3 shared a live Cloudflare-tunneled HLS relay
(`https://<tunnel>.trycloudflare.com/stream/direct-camNN/index.m3u8`)
for `direct-cam06`/`direct-cam07` -- the first time `process_hls_stream()`
could be tested against real relay infrastructure instead of a local
`.mp4` file. Direct `cv2.VideoCapture(master_url)` failed every time:
FFmpeg's stream-open hit its 30s internal timeout and gave up after all
`max_open_attempts`, even though `curl` on the exact same URL returned a
valid HLS manifest instantly.

## Root cause (confirmed, not guessed)

Fetched the master `index.m3u8` three times back-to-back with plain
`curl` -- each response referenced a *different* `?session=<uuid>`
variant-playlist URL. MediaMTX (the relay's HLS server) mints a brand
new session on every master-playlist GET. OpenCV's FFmpeg backend
issues more than one request while opening a stream (format probing,
then actual demuxing) -- by the time it tries to read segments, a
second internal request has already been assigned a newer session,
stranding the first one. That's what produced the 30s
`_opencv_ffmpeg_interrupt_callback` timeout on every attempt.

Verified the mechanism directly: resolving the master playlist once
with `requests.get()`, extracting the first non-comment line (the
session-scoped variant playlist URL), and handing *that* URL straight
to `cv2.VideoCapture()` opened in ~3s and read frames immediately.
Confirmed the resolved session stays valid across repeated
reconnects too, not just the first open.

## Fix: `anpr/streaming.py`'s `process_hls_stream()`

Added `_resolve_master_playlist()`, called inside `_open()` on every
attempt (including reconnects, so a stale/expired session gets a fresh
one automatically rather than looping on a dead one forever): fetches
the given URL, and if the first referenced line is itself another
`.m3u8` (i.e. this is a master playlist pointing at a variant), resolves
to that variant URL before passing it to `cv2.VideoCapture()`. Falls
back to the original URL unchanged if the fetch fails or the URL is
already a variant/plain HLS source with no master/variant split --
doesn't assume every HLS source needs this, only follows the pattern
when it's actually there.

## Live test result (real footage, real detection, not synthetic)

After the fix, ran the real pipeline against `direct-cam06`'s live feed
for ~3 minutes: connected immediately, no timeout. Real plate confirmed
three times across reconnects -- `GJ32AG2883`, confidence `0.99`,
`ok - pattern match` each time (same vehicle/scene, consistent with a
mostly-static camera view rather than a bug). Some H.264 decode
warnings appeared mid-stream (`cabac decode ... failed`, `error while
decoding MB ...`) -- consistent with occasional packet loss over a free
Cloudflare quick-tunnel, not a pipeline bug; the existing
reconnect-on-read-failure logic recovered cleanly every time without
manual intervention. `send_detection_to_watchlist` correctly attempted
and failed gracefully (`localhost:8001` unreachable, as expected --
no local backend running during this test); the detection/tracking/event
side of the pipeline worked end-to-end against real, live infrastructure
for the first time this project.

## What's not done / open

- Only tested against `direct-cam06` directly; `direct-cam07` uses the
  identical relay path pattern and the fix is generic (not
  cam06-specific), but wasn't separately re-verified this session.
- Not tested against a real reachable `backend-watchlist` -- the
  detection/tracking side is proven live now, but full
  detect-to-alert-to-frontend delivery still isn't, per the
  still-open Session 20/21/22 item.
- The tunnel URL is a Cloudflare quick-tunnel and will change if P3's
  container restarts -- not hardcoded anywhere in config, used only as
  a one-off test argument, per P3's own warning.

# Session 24 -- reconfirm cooldown: a broken-and-reformed track for the same real vehicle could log it twice

Real question raised, not hypothetical: if a vehicle sits in heavy
traffic and gets blocked from view by another car for more than
`MAX_MISSED_FRAMES` (5) processed frames, does it log twice on the same
camera?

Traced the actual mechanism: `PlateConfirmationTracker` (per-track)
already refuses to re-confirm within its own track once confirmed. But
when a track is lost (blocked/occluded past `MAX_MISSED_FRAMES`) and the
same real vehicle is picked back up, `VehicleTracker.update()` creates a
**brand-new track with a brand-new `PlateConfirmationTracker`** -- no
memory of the old one. The old `VehicleTracker`-level `self.confirmed`
set was only ever consulted by the VLM-fallback path
(`pop_ready_vlm_confirmations()`), not the normal OCR-confirmation path
in `update()` -- so a broken-and-reformed track for the same plate could
genuinely produce a second confirmed event and a second backend POST.

## Fix: time-bounded reconfirm cooldown, not a permanent one

`VehicleTracker.confirmed` changed from a plain `set()` to a `dict` of
`plate -> last-confirmed monotonic timestamp`. New
`RECONFIRM_COOLDOWN_SEC = 45` class constant, checked in both
confirmation paths (`update()`'s normal OCR path and
`pop_ready_vlm_confirmations()`) via a shared `_recently_confirmed()`/
`_mark_confirmed()` pair -- same dedup logic both paths already used,
just made consistent and given an expiry.

Deliberately **not** a permanent "never again" set: a camera that runs
for hours needs to treat the same plate returning much later (a genuine
separate sighting) as a new event, not silently swallow it forever. 45s
covers "blocked by traffic for a few seconds," not "came back this
afternoon." `_recently_confirmed()` also prunes expired entries on every
call, so this stays bounded over a long-running stream without a
separate cleanup pass.

## Verification

New `tests/test_reconfirm_cooldown.py` (pure logic, no models, matches
this project's existing `tests/test_pipeline_smoke.py` `__main__`-style
convention): confirms a plate once via one track, forces that track to
be pruned (feeds `MAX_MISSED_FRAMES + 1` empty frames), then re-confirms
the same plate via a second track at a different box -- asserts zero
events fire the second time. Passes.

## What's not done / open

- No real-footage test of this specific scenario (a real vehicle
  genuinely blocked mid-track) -- the fix is verified against the exact
  mechanism traced in the code, not observed against a real occlusion
  event in live footage, since reproducing that on demand isn't
  practical.
- 45s is a reasoned default (covers a traffic-light/blocked-view delay),
  not tuned against real measured occlusion durations -- worth revisiting
  if real footage shows blocks lasting meaningfully longer.

# Session 25 -- P3 handoff: 30 real Organizer cameras, cam01-30 -- real exponential backoff, configurable multi-camera runner, two honest blockers found

P3's handoff: Organizer's HLS relay now serves genuine live feeds only
(recorded fallback disabled), `direct-cam01` through `direct-cam30`,
same `.../stream/direct-camNN/index.m3u8?cookieCheck=1` pattern as
Session 23's single-camera test. Explicit asks: treat a missing/timed-out/
404 playlist as an unavailable camera and retry with backoff, no portal
credentials needed, keep the base URL configurable (temporary tunnel).

## Fixed: backoff wasn't actually exponential

`process_hls_stream()`'s `_open()` docstring already claimed "retries
with backoff," but the real implementation was a flat
`time.sleep(reconnect_interval_sec)` on every attempt -- not backoff at
all. Changed to real exponential backoff (`reconnect_interval_sec * 2 **
(attempt-1)`, capped at 30s so `max_open_attempts=10` can't add up to an
absurd total wait), matching the doubling pattern `event_sender.py`
already uses elsewhere in this codebase. A 404/timeout/missing camera
already fell through to this same retry loop generically (via
`cv2.VideoCapture.isOpened()` returning False) -- confirmed correct
before touching anything, only the delay itself needed fixing.

## Built: `run_organizer_cameras.py`, a configurable multi-camera runner

New CLI wrapper around `anpr.pipeline.orchestrator.ScalablePipeline`
(previously had no CLI wrapper at all, per Session 21's own note) --
`--hls-base-url` (or `HLS_BASE_URL` env var), `--cameras` (default
`1-30`), `--num-workers`, `--sample-rate`. Base URL is never hardcoded
anywhere, per P3's explicit ask and the same caution already applied to
every other Cloudflare quick-tunnel URL in this project.

`--num-workers` defaults to **1, not 30 or `len(cameras)`** -- real,
not assumed: Session 24's own testing already proved 2 concurrent
cameras on this single-GPU Mac produces a saturated frame queue and
**zero** confirmed events in 90s (vs. real detections when run one at a
time). Defaulting to fake/hopeful parallelism here would silently
under-deliver against a real 30-camera demo; documented plainly in the
script's own docstring instead, with instructions to only raise it on
real multi-GPU/multi-core hardware and re-verify there.

## Two real blockers found, not glossed over

1. **20 of 30 cameras have no numeric camera_id.** `CAMERA_ID_MAP` only
   covers `direct-cam01`-`direct-cam10` (P6/Dhruv-confirmed values 43-52
   from Session 20). `direct-cam11` through `direct-cam30` aren't in it
   at all -- confirmed by reading `anpr/config.py` directly, not
   assumed. Detections from those 20 cameras will run real local
   inference but `send_detection_to_watchlist`/`EventSender` will
   correctly no-op with a `[WARN]` rather than send a wrong camera_id --
   same fail-safe-not-fail-crash behavior already documented for
   unmapped cameras, just now affecting most of the fleet. Needs a real
   handoff to P6/registry for cam11-30's actual numeric ids before a
   full 30-camera run can reach the backend.
2. **The tunnel URL P3 gave doesn't resolve.** `curl` on
   `https://respiratory-football-fin-counties.trycloudflare.com/...`
   fails at DNS resolution (`Could not resolve host`), checked directly,
   not assumed to be a local network issue. Could be a typo, the tunnel
   not started yet, or DNS propagation delay -- worth confirming with P3
   before assuming the code is at fault if a live run fails.

## What's not done / open

- Not run against any of the 30 real cameras yet -- blocked on the
  tunnel resolving. `run_organizer_cameras.py` is written and its
  URL-building/argument-parsing verified directly, but not yet exercised
  against a real reachable relay.
- CAMERA_ID_MAP extension for cam11-30 needs real values from P6, not
  guessed -- same discipline as Session 20's real camera-id handoff.

# Session 26 -- fixed a real bug in Session 24's own cooldown fix: "Total confirmed plates" undercounted on a real GPU-server run

First real GPU-server run of `cam06.mp4` came back with ~85 real
`[CONFIRMED EVENT]` lines during the run, but the final `Total confirmed
plates` summary printed only 13. Traced directly, not guessed: Session
24's `RECONFIRM_COOLDOWN_SEC` fix reused `VehicleTracker.confirmed` for
two different jobs at once -- short-term cooldown suppression (which
needs continuous pruning to stay bounded) and the permanent end-of-run
summary (which must never lose an entry). `_recently_confirmed()` prunes
that same dict on every call, so by the time a ~7-minute real run ended,
only the last 45 seconds of confirmations were still in it. The actual
detection and (once camera_id is fixed, per the separate issue found in
this same run) backend-sending were never affected -- this was a
summary-print-only bug, not a data-loss bug.

## Fix: split into two structures with two different lifetimes

`VehicleTracker.__init__` now has `_recent_confirmations` (private,
plate -> timestamp, continuously pruned, cooldown-suppression only) and
`confirmed_plates` (public, plain `set`, permanent, every plate
confirmed this whole session). `_mark_confirmed()` updates both.
`anpr/streaming.py`'s three "Total confirmed plates" prints now read
`tracker.confirmed_plates` instead of the old `tracker.confirmed`.

## Verification

Extended `tests/test_reconfirm_cooldown.py`: after confirming the
cooldown-suppression behavior, forces a cooldown entry's timestamp into
the past directly (no slow real sleep) to simulate "long after
confirmation," asserts the cooldown check correctly reports expired,
and asserts `confirmed_plates` is unaffected by that pruning. Passes.

# Session 27 -- presentation-ready counts: vehicles tracked, plate candidates, confirmed-by-tier

Real ask, not speculative: needed real numbers for the presentation --
how many vehicles were seen, how many plate candidates were read, how
many confirmed and in which tier (pattern match / fallback / VLM). None
of this existed before except "confirmed_plates" itself; "vehicles
tracked" wasn't counted anywhere at all.

`VehicleTracker` gains three new counters: `total_vehicles_tracked`
(incremented once per new track created -- a distinct vehicle sighting,
same "sighting not unique physical car" caveat `confirmed_plates`
already documents), `total_plate_candidates` (every per-frame OCR read
with a non-empty plate guess, confirmed or not), and `confirmed_by_tier`
(note -> count, e.g. `{"ok - pattern match": 10, "ok - fallback,
unverified pattern": 1}`). `_mark_confirmed()` now takes `note` to feed
the tier dict.

`anpr/streaming.py`'s three separate summary prints replaced with one
shared `_print_summary()` helper so all three entry points
(`process_stream`/`process_video_file`/`process_hls_stream`) report the
same four lines consistently.

Verified live against `dashcam_trimmed.mp4`: `Vehicles tracked: 34`,
`Plate candidates read: 88`, `Confirmed plates by tier: {'ok - pattern
match': 10, 'ok - fallback, unverified pattern': 1}`, plus the existing
`Total confirmed plates` set (11 unique). Real counts, not estimated.

Explicitly NOT an accuracy number -- these are raw counts of what the
pipeline did, not a check against ground truth. Still cannot answer "did
accuracy improve vs. the ~59% Mac figure" without a fresh human-verified
comparison; these numbers answer a different, legitimately useful
question (volume/composition, for the presentation) instead.
