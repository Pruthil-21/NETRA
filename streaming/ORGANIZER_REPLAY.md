# Organizer footage replay

This optional container loops cam01.mp4 through cam30.mp4 from
`~/Downloads/NETRA-organizer-archive` into the existing MediaMTX paths
`stream/direct-cam01` through `stream/direct-cam30`. Files are mounted read-only.
H.264 video is copied without transcoding; audio is omitted. The archive's
cameras.json identifies the original camera names. Do not remap clips by name alone.

From this directory:

```sh
./switch_organizer_source.sh replay
./switch_organizer_source.sh live
```

The existing MediaMTX container and netra-live_default network must be running.
The script reads the publishing credential from `.env.federation-api.local`.
Set STREAMING_ENV_FILE to use another env file, or ORGANIZER_ARCHIVE_DIR to
change the clip directory. Never commit credentials or footage.

The switch stops the competing source before starting the selected source.
It leaves MediaMTX, Cloudflare, Anand replay and recording services unchanged.
Replay startup failure restores the live relay. Live upstream availability is
not guaranteed. Expect a player reconnect when switching.

Do not manually start netra-live-relay while replay is active, or run the full
live Compose `up` command: both publishers would compete for the same paths.
Use the switch script. Docker Desktop Stop/Start on one container does not stop
the other. The replay restart policy resumes the currently running container
after Docker restarts; an explicitly stopped container remains stopped.

Label the demo **Recorded organizer footage - replay**. These same-path streams
are indistinguishable from live inputs to downstream consumers. Pause live ANPR
and alerts or use an isolated demo backend before processing replay; replay wall
clock timestamps do not represent the original footage capture times. This
container does not change frontend labels, ANPR ingestion or archive settings.

Health checks require fresh FFmpeg progress from all 30 publishers. Individual
publishers retry after disconnects. Health status alone does not verify browser
playback. Check a feed at:
`https://stream.digdhrishti.me/stream/direct-cam01/`
