# DIGDHRISHTI continuous recording fleet

This is an additive recording service under `streaming/recording`. Existing live/replay scripts, stream URLs, credentials, and MediaMTX configuration are unchanged. No Git operations are required. This does not start or migrate the existing streaming stack automatically.

## What is implemented

- Kubernetes recording shards, each with an explicit bounded inventory, an independent persistent spool, supervised FFmpeg publishers and MediaMTX 1.20.0. Publishing is continuous, independent of viewers. Remux/copy is default; set `codec: h264` only for an incompatible source.
- A SHA-256 consistent-hash ring with 256 virtual points per shard. Adding one shard moves only its new share. Inventory generation refuses duplicates, unsafe stream paths and capacity overflow. Existing registry stream IDs are preserved literally, including `stream/direct-cam01` and `stream/demo-cam67`; no renumbering or invented coordinates.
- Dedicated PostgreSQL session ownership per shard, Kubernetes singleton StatefulSets and ReadWriteOncePod storage. Source retry uses bounded exponential backoff and jitter. Runtime credentials are never written to FFmpeg logs.
- Completed-segment hooks persist a local marker before upload. Four bounded upload threads per shard retry independently; camera capture continues during object-store outages until the spool reaches its reserve. Upload precedes the transactional segment index and audit insert. Crash retry is idempotent. Startup recovers probe-readable interrupted segments and flags them `recovered`.
- PostgreSQL metadata partitioned by 64 path hashes and daily start time. An owner-role scheduled migration creates partitions ahead of time. It never removes evidence. The runtime does not perform DDL.
- Segment hashes are stored with object metadata and the index. Playback downloads are verified against the indexed hash before remux. Exports record requesting actor, requested range, constituent segment hashes and output hash. Database audit is append-only **when deployment roles are correctly provisioned**.
- `/list` and `/get` retain the MediaMTX URL shape and list response fields. Storage location is hidden from consumers; all finalized, uploaded material uses S3 through the same API. Unuploaded hot spool material is deliberately not exposed as archived evidence. Default archive visibility lag is approximately one 60-second segment plus upload time.
- Camera health reports advancing video output progress, last archive completion, retry count and worker heartbeat. It does not decode every camera to validate visual content. A frozen scene with advancing frames is not identified as an image-quality fault.
- A partitioned monitor detects feed loss, missing workers, disk pressure and delayed archival. State transitions are audit-logged and queued transactionally; notification delivery uses retries and a stable idempotency key. The sink must deduplicate that key. Recovery does not overwrite an undelivered loss event.
- MediaMTX Prometheus metrics, archive aggregate metrics, alert rules and an importable Grafana dashboard.

## Start a pilot

Requires a Kubernetes cluster with a NetworkPolicy-capable CNI, a CSI storage class supporting **ReadWriteOncePod** and durable reattachment, PostgreSQL 16+, an existing S3-compatible bucket, and a container registry. Production requires multi-zone/HA versions of these dependencies. A laptop cluster is a pilot only.

From this directory:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp inventory.example.json inventory.local.json
cp .env.example .env.local
```

Fill `inventory.local.json` with the exact existing stream paths and **private, continuously reachable** RTSP or HLS sources. For organizer cameras, use the existing authenticated relay as the source; this module does not independently log in to the organizer portal or renew signed source URLs. For production, those relays must also run redundantly in the district infrastructure. Leaving the upstream on Dhruv's laptop leaves a single point of failure.

Fill `.env.local` with infrastructure and service secrets. Generate two independent secrets with `openssl rand -hex 32`; replace all example values. Restrict file permissions with `chmod 600 .env.local inventory.local.json`. Keep the new archive service key separate from federation's service key and MediaMTX API credentials.

Build and push your image (replace `YOUR_REGISTRY`):

```sh
docker build -t YOUR_REGISTRY/digdhrishti-recording:pilot-1 .
docker push YOUR_REGISTRY/digdhrishti-recording:pilot-1
.venv/bin/python render_fleet.py --inventory inventory.local.json --shards edge-0 --image YOUR_REGISTRY/digdhrishti-recording:pilot-1 --storage-class YOUR_DURABLE_CSI_CLASS --pilot --output fleet.local.yaml
kubectl create namespace recording
kubectl -n recording create secret generic recording-infra --from-env-file=.env.local
```

Create `recording-migration` separately with an owner-role `DATABASE_URL`; **do not give the runtime database owner privileges**. Execute `migrate.py` once using that role before starting the runtime. One method: run the built image in a one-off Kubernetes Job with `envFrom.secretRef.name: recording-migration`, command `python migrate.py`. Grant the runtime role:

- SELECT, INSERT on `segments` and `audit` (no UPDATE/DELETE/TRUNCATE privileges on evidence).
- SELECT, INSERT, UPDATE on `camera_health`, `health_states`, `notifications`.
- CONNECT to the recording database and USAGE on its schema.

Then apply and inspect:

```sh
kubectl apply -f fleet.local.yaml
kubectl -n recording get pods,pvc
kubectl -n recording logs statefulset/edge-0
kubectl -n recording port-forward service/recording-api 8097:8097
```

The generated manifest contains source credentials in Secrets. It is mode 0600 and ignored by Git; do not share or commit it. Pin the tested image digest for production. Registry changes and deployment are operator actions, not performed by these tools.

## Pruthil integration

Registry must authorize the officer and camera using existing RBAC **before** forwarding. Configure its recordings client with base `http://recording-api.recording.svc.cluster.local:8097` (or the private pilot endpoint), headers `X-Service-Key: <RECORDING_SERVICE_KEY>` and `X-Actor-ID: <authenticated officer ID>`. Strip user-supplied versions of both headers. Label the backend namespace `recording-client=true` to permit ingress. The recording DB stays separate.

1. Registry recordings route forwards `/list?path=<camera.stream_id>&start=<RFC3339>&end=<RFC3339>`. The response is an array of `{start,duration,url}`; returned URLs include short-lived camera/range/actor-scoped playback tokens.
2. The frontend uses the returned `url` directly. Existing frontend code that constructs `/get` itself without a token needs to switch to those URLs, or use an authenticated registry proxy. **No anonymous bypass is provided.** A service key must never enter browser code.
3. Set `PUBLIC_PLAYBACK_URL` to the HTTPS gateway that forwards to this service. Preserve `/get` and query parameters. Disable request-query logging at the gateway because playback tokens are bearer credentials; use same-origin routing or deliberately configured CORS if the frontend fetches these URLs. Tokens expire after 15 minutes; refresh through the authenticated listing route.
4. `/api/health?path=stream/demo-cam67` uses the same trusted headers. Display `effective_status`, `last_frame_at`, `last_segment_at`, `checked_at` and `retries`.
5. Confirm `NOTIFICATION_WEBHOOK` and its service-key contract with the existing notification sink. Payload: `{event: "recording.health", event_id, path, shard, state, at}`. States include `healthy`, `feed_lost`, `archive_delayed`, `worker_unavailable`, `disk_full`. POST retries until 2xx. There is no assumed undocumented backend endpoint.

`/list` defaults to the past 24 hours. Supply narrower explicit ranges for large archives; maximum query window 31 days and 10,000 segment rows. Returned spans are split into at most one-hour playback requests. `/get` accepts `format=mp4` or `fmp4`, maximum 3,600 seconds and 2 GiB input by default. Missing coverage returns 409; overlapping segments are exported as disjoint half-open slices, with earlier segments taking precedence. Overlap exports decode and re-encode the selected slices to avoid duplicated frames at non-keyframe boundaries; other exports retain keyframe-aligned stream copy. Original segments and timestamps are preserved. Integrity/storage failures fail closed, saturated export pods return 429, and clip assembly exceeding 180 seconds returns 504 with a request to use a shorter range. Overlap exports use more CPU than stream-copy exports. `X-Content-SHA256` identifies the prepared output. `export.prepared` means prepared for delivery, not proof the user downloaded it completely.

## Scale and availability

The Anand deployment generator selects `digdhrishti-recording:overlap-fix` for the API. Before applying its generated manifest on a new machine, build this directory with `docker build -t digdhrishti-recording:overlap-fix .` and load that image into the cluster (`kind load docker-image digdhrishti-recording:overlap-fix --name digdhrishti-anand` for the local Kind cluster). The archive fix is export-side; it does not change stored segment boundaries or impose a database non-overlap constraint.

Run a measured single-shard pilot, then 10 shards, then district fleets. Start around 250–400 passthrough streams per shard and establish a measured limit; the default 500 limit is a protective admission budget, **not a measured capacity claim**. Separate ingest capacity from export capacity: API replicas each admit two concurrent exports, and can be increased independently. Do not automatically HPA the recording StatefulSets: changing ownership requires the controlled plan below.

The placement test covers **100,001 IDs across 256 shards**, not 100,001 video streams. At 1.5 Mbps per camera the fleet needs about 150 Gbps input, 1.62 PB/day and 48.6 PB for 30 days before replication, indexing and overhead. Sixty-second segments mean about 144 million segments/day and 1,667 uploads/second. Benchmark PostgreSQL ingestion, daily partitions, S3 request rates, spool IOPS and query latency at this workload; split by district into independent metadata/storage deployments when the measured regional budget is reached. Regional endpoints must be selected by the registry's camera-to-region mapping; this package does not invent that mapping or provide a global database router.

A one-hour buffer at 500 × 1.5 Mbps is about 337.5 GB. The manifest requests 1 TiB per shard as a starting outage buffer. Local cleanup removes **only this service's acknowledged runtime segments** after `HOT_BUFFER_SECONDS`; unknown or unuploaded files are retained. Low disk stops publishers visibly rather than deleting unarchived evidence. Storage tiering, object retention, legal holds, immutable object lock, backup retention and audit retention require policy decisions; no destructive cloud lifecycle is applied automatically.

Scale-out procedure: render a proposed inventory with stable old shard names plus new names; review changed assignments; stop affected old publishers before starting the new assignments; apply and roll affected shards in small batches. Moving an owner may produce a visible reconnect gap. Never force-delete a StatefulSet pod on a partitioned node without storage fencing. A PostgreSQL session lock does not substitute for node/storage fencing. Keep each old PVC until its spool is uploaded. Do not scale a given shard StatefulSet above one replica. Fleet membership changes are explicit; no claim of automatic ingest autoscaling is made.

This provides gap **detection**, not zero data loss: upstream outages, node failover, an unfinished one-second recording part, or loss of an unreplicated hot volume can lose footage. Use replicated durable CSI volumes, HA PostgreSQL, redundant S3, reliable time synchronization, redundant upstream relays, multi-zone scheduling and monitored backups. Geographic camera networks and credentials are deployment inputs; no one-Mac deployment meets the spec's HA requirement.

## Monitoring

Scrape recorder pod port 9998 only from a namespace labeled `recording-monitoring=true`; there is no external MediaMTX API or publish port in this fleet. Scrape API `/metrics` using a reverse proxy that injects the trusted service/actor headers (actor `prometheus`); do not put secrets in dashboard JSON. Import `k8s/grafana-dashboard.json`, select your Prometheus data source and load `k8s/alerts.yaml`. Scope the generic kubelet disk rule to your recording PVCs. Monitor CronJob failures, PostgreSQL replication, S3 errors and kubelet volumes with the cluster's standard infrastructure rules as well.

## Verification and current limits

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python tests/smoke_media.py
```

The smoke test uses the existing native MediaMTX binary and local FFmpeg, synthetic video and a temporary directory. It verifies continuous recording without viewers, durable completion hooks, decodable segments and exports, audit preparation and rejection of corrupted input. Its database and object-store interfaces are test doubles; it is not an S3/PostgreSQL integration test.

Docker was unavailable during implementation. Container build, actual PostgreSQL/S3 transactions, Kubernetes scheduling/failover, real notification delivery, real organizer ingest and high-volume video traffic still require deployment verification. Do not label this production-qualified until those gates pass. See `VALIDATION.md` for the exact evidence.

Implementation references: [MediaMTX recording](https://mediamtx.org/docs/features/record), [completion hooks](https://mediamtx.org/docs/features/hooks), [playback contract](https://mediamtx.org/docs/features/playback). The source spec is implemented as a separate fleet, not applied as instructions to alter backend ownership or existing demo paths.
