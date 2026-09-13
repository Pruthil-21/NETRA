# Recording implementation validation — 2026-09-08

- 8 automated tests passed: 100,001-ID placement and scale-out movement, capacity rejection, path/time validation, gap detection, bounded reconnect jitter, playback token scope/expiry, spool retention on upload failure, and idempotent segment audit preparation.
- Real native MediaMTX **1.20.0** and FFmpeg captured 9 seconds of synthetic video with no viewer. Five completed segment markers were produced. Each segment decoded successfully.
- The real `/get` implementation assembled and decoded a four-second MP4 from those segments. Its response hash matched the output file. Deliberately corrupting an expected source hash rejected playback with HTTP 502.
- Playback smoke used database and object-store doubles. No claim of PostgreSQL/S3 end-to-end verification is made.
- Python source compilation and Kubernetes generator structure checks passed. Kubernetes API admission and image build have not been run.
- No real source credentials, existing stream processes or external deployments were changed by tests. Only temporary synthetic recordings were cleaned up.

## Required deployment gates

1. Build the image; apply SQL against PostgreSQL 16+ using a migration role; verify runtime append-only audit permissions and forward partition creation. For replay/backfill of older capture dates, create corresponding daily partitions before upload.
2. Upload to the selected S3 system, read back and verify; test DB failure after upload, crash before receipt, and prolonged S3 outage. Confirm spool survives pod/node replacement and never deletes unacknowledged footage.
3. Verify real camera output progress, completion markers and exports across multiple segments/codecs. Verify organizer relay credential renewal independently.
4. Exercise authenticated registry listing, scoped browser playback, expired tokens, camera RBAC, notification idempotency, and inaccessible private ports.
5. Stop a source, kill a pod, disconnect object storage and database, fill a test spool and interrupt the notification sink. Confirm every failure becomes visible and recovery preserves evidence/audit history.
6. Load-test 1, 30, 250, then the proposed per-shard camera limit. Measure CPU, RSS, packet loss, recording gaps, upload age, S3 rate, DB commit latency, PVC throughput and export saturation for at least 24 hours before increasing fleet size.
7. Test regional failover and a controlled ownership move. Measure footage loss during failover; zero-gap recording has not been demonstrated.

**100,001 simulated camera IDs are not a 100,001-camera video load test.** Infrastructure procurement, retention/legal-hold policy, regional placement, HA credentials/endpoints and operator deployment remain required.
