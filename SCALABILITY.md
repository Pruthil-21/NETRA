# NETRA — Scalability Plan

*No existing infrastructure/scalability write-up was found elsewhere in
this repo (checked the root and looked for a `docs/` folder) — this is a
standalone document from the ML/processing side. If a teammate has since
written a network/bandwidth/storage/disaster-recovery doc, this should be
reconciled with it rather than read as the full picture.*

Written in the same spirit as `SECURITY.md`: honest and grounded, willing
to say "this needs more infrastructure before it scales" rather than
claim readiness this prototype doesn't have.

## 1. AI Processing Capacity

### Where the numbers come from

Checked directly in `ml-anpr/detect_plate.py`:

- `process_stream()` (live RTSP source) samples every 30th frame by
  default (`process_every_n_frames=30`).
- `process_hls_stream()` (live HLS source, e.g. the Cloudflare-tunneled
  demo feed) samples every 15th frame by default.
- `process_video_file()` samples every 10–15th frame depending on the
  call site.
- Source video in this repo runs at ~30fps (confirmed on
  `dashcam_trimmed.mp4`, `cap.get(cv2.CAP_PROP_FPS)` = 29.97).

Frame sampling alone would suggest 1–3 analyzed frames/second/stream. But
the actual bottleneck measured on this dev machine is worse than that:
running the full pipeline (YOLO on Apple Silicon MPS + two EasyOCR passes
per frame — whole-vehicle crop and a plate-region sub-crop — EasyOCR
itself runs on CPU regardless of device, since it's initialized with
`gpu=False`) against `dashcam_trimmed.mp4` took **~168 seconds
wall-clock for 163 analyzed frames** — roughly **1 frame analyzed per
second, per stream, on one unshared dev machine**. Frame sampling isn't
the limiting factor; per-frame inference time is.

Device selection is automatic (`mps` / `cuda` / `cpu`, checked in that
order via `torch.backends.mps.is_available()` / `torch.cuda.is_available()`),
so this scales across teammates' different hardware without code changes
— but today, every stream's YOLO + EasyOCR pipeline runs on a single
machine, one process per stream, with no batching across streams and no
dedicated inference server.

### What "current -> statewide" actually requires

At ~1 analyzed frame/second/stream on a single unshared dev machine, this
architecture realistically handles a handful of concurrent streams before
falling behind real-time — which is fine for a prototype demo, and not
remotely sufficient for the problem statement's eventual scale
(~80,000 cameras statewide). Closing that gap is an infrastructure
problem, not a model-accuracy problem, and has two real levers:

**GPU inference and batching.** The current pipeline processes one frame
from one stream at a time on whatever device is available locally.
A production deployment would run YOLO (and ideally a GPU build of
EasyOCR, or a comparable GPU-accelerated OCR engine) on dedicated
inference servers, batching frames from multiple streams into a single
forward pass. Batched GPU inference doesn't scale 1:1 with stream count
the way today's one-process-per-stream model does — it's the difference
between "80,000x the compute" and "enough GPU capacity to keep a batch
queue full," which is a fundamentally different and much smaller number.

**Tiered / on-demand processing, not all-cameras-all-the-time.** Running
real-time ANPR on all ~80,000 cameras simultaneously, all the time, isn't
the right target even with unlimited budget — most feeds don't need
continuous plate-level analysis. The more realistic model: ANPR runs
continuously only on a smaller set of high-priority streams (checkpoints,
watchlisted-corridor cameras, cameras a department has actively flagged
for an investigation), with the rest of the registry available for
on-demand activation — an officer or department pulls ANPR onto a
specific camera or corridor when it's actually needed, rather than
paying the compute cost for cameras nobody is currently querying. This
mirrors how the registry is already structured (cameras are individually
addressable, not a monolithic always-on feed), it's a natural extension
of the existing `camera_id`-scoped detection contract in
`contract/API_CONTRACT.md`, and it's the only version of "statewide ANPR"
that's actually affordable — see the cost section below.

## 2. Cost-Benefit Analysis

Numbers below are deliberately rough, labeled as such, and meant to show
the shape of the tradeoff — not a budget anyone should commit to without
a real infrastructure proposal.

**Current prototype scale.** Effectively zero marginal infrastructure
cost: everything runs on teammates' own laptops, a free Cloudflare quick
tunnel, and local Postgres/MediaMTX containers. This tells us nothing
about production cost — it's a demo, not a deployment.

**Rough extrapolation toward statewide scale.** Assume the tiered model
above rather than all-cameras-always-on: say a low-single-digit
percentage of ~80,000 cameras (a few thousand streams) running
continuous ANPR at any given time, the rest available on-demand. A few
thousand concurrent GPU-batched inference streams is a real, budgetable
cloud GPU inference cluster — plausibly low-to-mid six figures per year
in inference compute alone at rough current cloud GPU pricing, before
storage, bandwidth, and the non-ML backend/registry infrastructure. That
is a genuinely large number, and this document isn't going to pretend
otherwise or fake precision it can't back up — the honest statement is
"this needs a real costed infrastructure proposal before statewide
rollout is a budget decision, not a rough estimate in a hackathon repo."

**Weighed against the actual problem.** The stated problem NETRA
addresses isn't "no analytics anywhere" — it's 26 departments running
independent, duplicated CCTV infrastructure with no unified registry,
no shared analytics, and slow cross-department investigation when a
plate or incident needs to be traced across jurisdictions. The
comparison that actually matters isn't "cost of NETRA vs. cost of
nothing" — it's "cost of a unified layer vs. the ongoing cost of 26
departments each separately building (or not building) the same
capability, and the real cost of slow cross-department correlation
during an active investigation." That's a genuine case for a unified
system; it is not, by itself, a case for building it as an
all-cameras-always-on system from day one.

## 3. Statewide Rollout Plan

A phased rollout, not a big-bang statewide launch:

1. **Pilot (1–2 departments/cities).** Deploy the registry, unified
   viewing, and tiered ANPR against a real but bounded set of cameras in
   one or two departments — enough to validate the architecture against
   real traffic patterns, real plate variety, and real department
   workflows, not just curated test footage. This is also where the
   real numbers this document is missing get filled in: actual
   concurrent-stream counts departments need live, actual false-positive
   rates against real (not hackathon-test) footage, and a real
   infrastructure cost baseline instead of the rough estimate above.
2. **Validate before expanding.** Confirm the tiered/on-demand model
   holds up under real department usage — do officers actually use
   on-demand activation the way this plan assumes, or does real usage
   look different? Confirm the audit trail and RBAC model (documented in
   `SECURITY.md`) hold up under real multi-department access patterns,
   not just the prototype's two-service test suite.
3. **Expand by region, not statewide at once.** Roll out to additional
   departments in groups, each addition validated against the pilot's
   findings rather than assuming the pilot's numbers generalize
   automatically. Statewide coverage of ~80,000 cameras is the
   long-run target, not a launch-day target.

Claiming a realistic path to full statewide rollout in one step, on a
5-day hackathon build, would be the kind of overclaiming this document
is deliberately avoiding — a working pilot with honest numbers is a much
stronger position to expand from than an unvalidated statewide claim.
