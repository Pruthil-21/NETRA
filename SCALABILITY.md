# NETRA — Scalability Plan

This document combines measured behavior from NETRA's ML and streaming
prototype with an infrastructure plan for scaling from approximately
30–50 demonstration cameras to roughly 80,000 registered cameras across
Gujarat.

The prototype is not presented as production-ready. Capacity figures
below are planning envelopes rather than procurement commitments and
must be validated through regional load tests using representative
department feeds, codecs, resolutions, frame rates, and viewer patterns.
Where the prototype made a deliberate choice—such as live-only relay
without centralized video recording—the statewide plan preserves and
explains that choice.

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

## 3. Hardware and Software Requirements

### What the prototype proves

The current streaming service launches one retry worker per registered
camera. Each worker pulls organizer HLS, converts the video to H.264 with
FFmpeg when necessary, publishes it to MediaMTX over RTSP, and exposes
Low-Latency HLS for browsers.

Running 30 workers does not mean the laptop has demonstrated 30 stable
simultaneous transcodes. During testing, only about 5–9 organizer feeds
were normally publishing at one time, and individual 1080p software
transcodes sometimes consumed a substantial portion of one CPU core.
The prototype proves path orchestration, retry behavior, and browser
delivery; it does not establish statewide server capacity.

### Production node classes

A production deployment should separate these responsibilities:

- **Registry/API nodes:** Stateless FastAPI containers behind a load
  balancer, backed by highly available PostgreSQL/PostGIS.
- **Regional relay nodes:** MediaMTX and FFmpeg workers located near
  department VMS systems, preventing every source stream from crossing
  the state network unnecessarily.
- **Transcode nodes:** Dedicated CPU or hardware-encoder nodes used only
  when a source codec is incompatible with browser playback. Existing
  H.264 feeds should be passed through without re-encoding.
- **Inference nodes:** GPU-backed workers that batch frames from selected
  cameras for ANPR.
- **Observability services:** Central metrics, logs, alerts, stream-health
  checks, and capacity dashboards.

A reasonable starting specification for a regional relay node is
16–32 CPU cores, 64–128 GB RAM, SSD storage for the operating system and
temporary buffers, and dual 10 GbE networking. Hardware video encoders
should be added where many H.265 or otherwise incompatible feeds require
conversion.

The following are initial load-test targets, not guaranteed limits:

| Workload | Initial planning envelope per node |
|---|---:|
| H.264 pass-through and HLS packaging | 100–200 active HD feeds |
| Software H.264 transcoding on a 32-core node | 8–16 active 1080p feeds |
| Hardware-assisted transcoding | Benchmark per selected GPU before procurement |

At 5% statewide concurrency, 4,000 active feeds would require roughly
20–40 pass-through relay nodes before redundancy and headroom. If every
feed required software transcoding, the node requirement would be far
higher; therefore codec normalization and hardware encoding are core
design requirements, not optional optimizations. Production capacity
should retain at least 30% headroom and reject or redirect new sessions
before a node begins accumulating latency.

The production software baseline should use Linux containers, an
orchestrator with health-based rescheduling, MediaMTX, FFmpeg,
PostgreSQL/PostGIS, a queue for detection work, centralized secrets,
and metrics/log aggregation. The current shell launcher remains useful
for development but should be replaced by supervised per-camera workers
in production.

## 4. Network and Bandwidth Planning

Observed NETRA HLS manifests advertised approximately 4–10 Mbps for
1080p organizer feeds. The video codec and quality dominate bandwidth;
changing RTSP ingest into HLS or WebRTC changes delivery behavior but
does not remove the underlying media bitrate.

A naive design that continuously ingests every camera would require:

| Concurrent share of 80,000 cameras | Active cameras | Source ingress at 4–10 Mbps |
|---:|---:|---:|
| 1% | 800 | 3.2–8 Gbps |
| 5% | 4,000 | 16–40 Gbps |
| 10% | 8,000 | 32–80 Gbps |
| 100% | 80,000 | 320–800 Gbps |

These figures cover one incoming copy of each stream only. Browser
viewers create additional egress. HLS should therefore be cached at
regional edges or a CDN so multiple viewers do not repeatedly pull the
same media from a relay. WebRTC should use an SFU for multi-viewer cases;
one direct connection per viewer would multiply relay egress.

NETRA should use tiered ingest:

1. Keep registry metadata and health status available for all cameras.
2. Continuously ingest only priority checkpoints, active watchlist
   corridors, and operationally critical feeds.
3. Start other relays on demand when an authorized user opens a feed or
   activates an investigation corridor.
4. Stop idle relays after a configurable grace period.
5. Prefer department-local or regional processing and send only required
   media or detection events to central services.

Regional links should be sized from measured concurrent demand, with at
least 30% capacity headroom. Adaptive profiles should be available:
high-resolution streams for evidence review, lower-bitrate substreams
for map previews, and sampled frames for AI. Health checks must measure
packet loss, segment age, reconnect frequency, end-to-end latency, and
available bandwidth—not merely whether a playlist returns HTTP 200.

The prototype's Cloudflare Quick Tunnel is suitable only for
demonstration. Production requires stable authenticated ingress,
controlled public or government-network egress, TLS, rate limiting, and
regional routing. Camera publishing endpoints must not be exposed as
unauthenticated public RTSP services.

## 5. Storage and Retention Strategy

The prototype intentionally relays live video without downloading or
centrally recording camera footage. This follows the hackathon's
live-consumption constraint and is also the most practical statewide
storage design.

At statewide scale, existing departmental VMS/NVR systems should remain
the systems of record for video retention. NETRA should centrally store
only:

- Camera registry and ownership metadata.
- Connectivity and health history.
- ANPR detections and confidence values.
- Watchlist matches and alert-status history.
- User access and audit logs.
- References to the originating department, camera, and timestamp.

This avoids duplicating 80,000 continuous video archives in a central
platform, reduces network transfer, preserves departmental retention
rules, and limits the impact of a central storage breach.

PostgreSQL tables containing high-volume detections and health events
should be time-partitioned, indexed by camera and timestamp, and governed
by department-approved retention periods. Older operational metrics can
be aggregated before deletion. Backups must be encrypted and tested
through regular restores.

If evidentiary clips are added later, they should be an explicit,
authorized workflow—not continuous recording. A clip should remain in
the department VMS where possible. Any centrally retained evidence
should use encrypted object storage, immutable audit records, checksums,
role-based access, legal retention policies, and automatic lifecycle
deletion. The prototype does not currently implement this capability.

## 6. Disaster Recovery Strategy

### Current behavior

The current relay script automatically reconnects failed organizer feeds
and retries after a configurable delay. The unified launcher stops and
starts MediaMTX, FFmpeg relays, and the demonstration tunnel together.
This handles individual source interruptions but still leaves the Mac as
a single point of failure.

### Production behavior

Production relay workers should be supervised independently so one
broken camera cannot restart an entire node. Each region should run at
least two relay instances across separate failure zones. Stream
ownership should be assigned through leases or a coordinator so only one
primary worker publishes a path, while a standby can take over without
creating duplicate publishers.

Required recovery controls include:

- Health-based restart and rescheduling of MediaMTX and relay workers.
- Exponential retry with jitter and circuit breaking for persistently
  offline cameras.
- Active-active API instances behind a load balancer.
- PostgreSQL replication, encrypted backups, point-in-time recovery, and
  regularly tested restore procedures.
- Alternate regional relay URLs so frontend and ML consumers can retry
  another healthy node.
- Central alerts for publisher loss, stale HLS parts, excessive latency,
  disk pressure, CPU/GPU saturation, and database replication lag.
- Configuration and secrets stored outside individual relay machines.

Because NETRA does not centrally retain video, relay failure has no video
archive recovery requirement: live viewing is unavailable during the
outage, while departmental VMS retention remains intact. Registry,
watchlist, detection, and audit data do require recovery.

Initial pilot objectives should target relay-service recovery within
five minutes of a node failure and metadata recovery with no more than
15 minutes of data loss. These are proposed engineering targets and
must be confirmed with departments before production rollout. Disaster
recovery exercises should be performed before each regional expansion.

## 7. Statewide Rollout Plan

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
