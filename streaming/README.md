# DIGDHRISHTI Streaming


Camera video is relayed through FFmpeg and MediaMTX for browser playback and ML processing. Federation discovers inventory and playback links; it does not replace this streaming service.

## Choose one operating mode

| Mode | Configuration | Source and public access |
|---|---|---|
| Organizer live + separate demo recordings | `compose.live.yaml` | Portal live feeds; `demo-*` replay paths; named Cloudflare tunnel |
| Recorded demonstration | `compose.recorded.yaml` | Local MP4 archives; temporary Cloudflare Quick Tunnel |
| Live with recording fallback | recorded configuration + `compose.hybrid.yaml` | Switches between recording and live on the same `direct-*` path |
| Simulated device monitoring | optional `compose.snmp.yaml` | Mock SNMP data only; not actual device reachability |

Run only one video stack at a time. The modes share container names and listening ports. Existing `netra-*` infrastructure names and archive paths remain for compatibility.

## Start the live stack

Requirements: Docker Desktop running, organizer email/password files, the existing Cloudflare tunnel token, and the six AVI files listed in `docker/demo-replay-entrypoint.sh` under `~/Downloads/Demo_Footage`.

From this directory:

```sh
test -s .organizer-email && test -s .organizer-password
test -s "$HOME/.config/netra/cloudflare-tunnel-token"
chmod 600 .organizer-email .organizer-password
docker compose -f compose.live.yaml config --quiet
docker compose -f compose.live.yaml up -d --build
docker compose -f compose.live.yaml ps
```

Credentials are runtime secrets and must not be committed or included in a shared folder. `.dockerignore` excludes them, local videos and binaries from image build contexts. Do not print credential files into logs.

The default camera limit is 30; it is a resource budget, not proof of capacity. Set `CAMERA_LIMIT` explicitly for your machine. A nonempty valid manifest with fewer cameras is accepted. IDs must match the organizer's `cam<number>` convention and be unique in the selected set.

Configure the existing named Cloudflare tunnel's streaming hostname to route to `http://mediamtx:8888` on this Compose network. The expected public base is `https://stream.digdhrishti.me`; its live route was not verified in this review. Do not start another tunnel or change the public hostname unnecessarily.

If demo recordings are unavailable, start only the required live services:

```sh
docker compose -f compose.live.yaml up -d --build mediamtx live-relay cloudflared
```

## Paths and source truth

| Source | Browser HLS suffix | Local RTSP |
|---|---|---|
| Organizer camera `cam01` | `/stream/direct-cam01/index.m3u8` | `rtsp://127.0.0.1:8554/stream/direct-cam01` |
| Demo camera `cam67` | `/stream/demo-cam67/index.m3u8` | `rtsp://127.0.0.1:8554/stream/demo-cam67` |

Use `http://127.0.0.1:8888` locally or the configured public streaming base for HLS. Container consumers use `mediamtx` instead of localhost. Organizer inventory and authentication use `https://cctv.corp8.cloud`; the live stack does not use the older `live.corp8.cloud/api/cameras` endpoint.

The recorded and hybrid modes also use `direct-*` paths. A path name alone therefore cannot prove live footage. Present these modes as recorded/fallback demonstrations, never as verified live camera video. The mock SNMP service also must remain visibly labeled simulated.

The supplied MediaMTX configuration uses **fMP4 HLS**, seven segments and a one-second target segment duration. It does not currently select the `lowLatency` variant. Actual latency depends on source keyframes, transcoding, delivery and the player. Live relays copy compatible streams and transcode the configured camera subset.

## Health and operation

```sh
docker compose -f compose.live.yaml logs --tail=100 live-relay mediamtx cloudflared
curl --fail --max-time 10 'http://127.0.0.1:8888/stream/direct-cam01/index.m3u8?cookieCheck=1'
docker compose -f compose.live.yaml exec live-relay sh -c 'for f in /tmp/netra-live/status/*; do printf "%s: " "${f##*/}"; cat "$f"; done'
```

Live-container health requires recent successful authentication and at least one online camera with an HLS playlist. It does not mean every camera works or certify segment decoding. Inspect individual camera states and play the intended demo feeds. Docker marks an unhealthy container but does not automatically restart it solely because of its health status. Unexpected live/recorded supervisor exits now fail the container so its restart policy can recover it.

```sh
docker compose -f compose.live.yaml down
```


This stops the selected stack. Do not run it during a demo unless you intend to interrupt streaming. Changes to entrypoint scripts require rebuilding their images; files on disk do not update already running containers.

## Recorded footage / archive playback

The six Anand cameras share one replay source for live viewing and recording.

The recording service in `streaming/recording` stores footage and provides timeline lookup, playback, and clip export. Backend-registry authenticates requests and maps registry cameras to their stream paths. Playback uses signed URLs returned by the recording service.

Recording runs independently of whether someone is watching the live stream.

## Utility scripts


`rtsp_reader.py` provides raw/resized latest frames, rejects frames older than two seconds by default, bounds FFmpeg-backed OpenCV I/O attempts and avoids concurrent capture/release. It requires OpenCV with the FFmpeg backend and timeout support. Network/video integration still needs testing on the target runtime; it is not a zero-latency guarantee.

## Federation access

The MediaMTX control API is enabled through the authenticated federation Compose overlay. Port 9997 is bound to loopback and forwarded privately through Tailscale.

The inventory endpoint is `http://100.105.88.26:9997/v3/paths/list`. Access requires HTTP Basic authentication. The federation adapter filters the six Anand cameras using `stream/demo-`. Credentials must remain outside Git.

## Preserved utilities

- `start_streaming.sh`, `start_live_proxies.sh`, `start_all_cameras.sh`: older provider workflow; not the primary live-stack instructions.
- `start_organizer_stack.sh`, `organizer_remote_feeds.sh`: native organizer workflow; retain pending a separate compatibility check.
- `start_file_feed.sh`, `start_live_cam.sh`: local video/webcam testing.
- Phone/Xiaomi/go2rtc utilities: optional local camera integrations.
- `stream_downloaded_organizer_feeds.sh`: native archive replay.
- `benchmark_recorded_stack.sh` and `RECORDED_STREAMING_RUNBOOK.md`: recorded-mode verification.

No utility was deleted during this review. Only the approved `go2rtc.zip` installer archive was removed; the executable and its configuration remain.

## Verification

```sh
python3 -m unittest discover -s tests -v
docker compose -f compose.live.yaml config --quiet
docker compose -f compose.recorded.yaml -f compose.hybrid.yaml -f compose.snmp.yaml config --quiet
```


## Continuous recording fleet

The additive Kubernetes recording implementation is in [recording/README.md](recording/README.md), with rollout steps, Pruthil's playback/health contract, integrity controls and scale assumptions. See [recording/VALIDATION.md](recording/VALIDATION.md) for tested behavior and deployment gates. Existing demo commands are unchanged.

## Shared Anand replay and recording

Run `python3 prepare_demo_footage.py` once before starting demo replay. It creates H.264 MP4 files in `~/Downloads/Demo_Footage/prepared` without changing the AVI originals. Subsequent runs skip unchanged completed files. For a damaged AVI whose header overstates its recoverable duration, `--allow-shorter` records the mismatch in the preparation receipt.

Demo replay uses stream copy. The Anand recording pilot reads the same MediaMTX relay through `host.docker.internal:8554`; its legacy replay and source deployments remain at zero replicas. This avoids encoding the six videos twice.

For private inventory access, set a random `MEDIAMTX_API_PASSWORD` in `.env.federation-api.local`, then run `bash start_federation_api.sh`. This starts the authenticated API on loopback port 9997 and forwards it privately through Tailscale. Clients use HTTP Basic authentication with username `federation` and filter paths by `stream/demo-`. Preserve the API Compose overlay when recreating MediaMTX; do not route its control API through the public streaming hostname.
