# NETRA — Security Overview

Implemented vs. deferred controls, documented honestly for judges rather
than overclaiming.

## Implemented

- JWT-based RBAC (public/officer/admin roles) across backend-registry
  and backend-watchlist. Read endpoints require authentication
  (`get_current_user`); write endpoints require officer role or higher
  (`require_role("officer")`). Verified directly in both services'
  route definitions: backend-registry's `POST`/`PUT`/`DELETE /cameras`
  and backend-watchlist's `GET /watchlist`, `POST /watchlist`,
  `GET /alerts`, and `PATCH /alerts/{id}` all gate on `require_role`.
- Service-to-service auth for ml-anpr -> backend-watchlist via a shared
  `X-Internal-Key` header (`require_internal_key`), not a user JWT,
  since it's machine-to-machine. The key currently defaults to the
  placeholder `dev-internal-key` if `INTERNAL_SERVICE_KEY` isn't set in
  the environment — fine for local/demo use, but this default must be
  overridden with a real secret before any real deployment.
- Audit logging: every camera view/create/update/delete and every alert
  create/status-change is logged to an `audit_logs` table. This table
  is independently implemented per service (backend-registry and
  backend-watchlist each own their own `audit_logs` table and
  `audit_service.py`, by design — kept duplicated rather than shared to
  preserve zero-cross-folder-dependency ownership between services),
  not a single table shared across services.
- Append-only alerts: `alerts.status` is never directly updated; status
  transitions append to a separate `alert_status_history` table, and
  the current status is derived by reading the latest entry. Verified
  via `backend-watchlist/tests/test_alerts.py`, which asserts the raw
  `alerts.status` column stays `"NEW"` after a status update while
  `alert_status_history` accumulates one row per transition.
- No secrets committed to source control. `.env`/`.env.local` are
  gitignored at the repo root; `.env.example` / `.env.local.example`
  files (frontend-map, streaming) contain
  placeholders only. Confirmed no tracked `.env` file exists anywhere
  in the repo.
- CI (`.github/workflows/ci.yml`) runs lint (`ruff` / `next lint` or
  `eslint`) and tests (`pytest`, against a real ephemeral
  `postgis/postgis` Postgres service container, not a mock) on every
  PR before merge. CI environment values (e.g. `JWT_SECRET:
  ci-test-secret-not-for-production`) are clearly labeled as dummy,
  not real secrets.
- Password security: officer passwords are bcrypt-hashed
  (`auth_service.hash_password`/`verify_password`), never stored or
  compared in plaintext. Login is timing-attack resistant — a badge
  number with no match still runs `verify_password` against a
  precomputed dummy hash (`DUMMY_PASSWORD_HASH`), so response time
  doesn't leak whether a badge number exists.
- Fine-grained RBAC beyond the role check above: backend-registry's
  `require_permission`/`has_permission` check an explicit permissions
  list issued per officer posting (`auth_service.issue_token`, scoped
  by `scope_type`/`scope_value`, e.g. a jurisdiction), on top of the
  coarser role gate — backward-compatible with pre-RBAC demo JWTs
  (role-only, no permissions claim), which are still treated as fully
  trusted rather than breaking existing test fixtures/tokens.
- Separation of duty on alert escalation: an officer who already made
  a status change on an alert cannot be the one who escalates it
  (`alerts_service.has_prior_status_change`, enforced in
  `routers/alerts.py`'s `PATCH /alerts/{id}` — verified as an actual
  gate on the ESCALATED path, not just a defined-but-unused helper).
- Feature kill-switches fail closed as 404, not 403
  (`require_scale_demo_enabled`) — a disabled synthetic/scale-demo
  route looks like it doesn't exist rather than revealing the feature
  is present but off.
- The new government-database lookup endpoints (`GET
  /vehicle-lookup/{plate}`, `GET /license-lookup/{dl_number}` — VAHAN,
  eGujCop, SARTHI readiness) are gated by the same `require_role("officer")`
  as every other officer-facing route. They currently return an honest
  `"not_configured"` placeholder (no real VAHAN/eGujCop/SARTHI
  credentials exist yet), so there's no real external PII exposure
  risk from this surface today — noted here so it's tracked for when
  real credentials are added.

## Explicitly Deferred (documented gaps, not built)

- TLS/HTTPS in transit — local HTTP + an unauthenticated Cloudflare
  quick tunnel for the live demo feed; needs TLS and a stable
  authenticated tunnel for real deployment.
- Real ONVIF camera authentication — out of scope for this prototype.
- Encryption at rest for the database.
- Automated retention-period purging — the registry tracks a
  `retention_days` field per camera (confirmed in `schema.sql`,
  `cameras_service.py`, and covered by `test_cameras.py`), but no
  automated purge job reads it or deletes expired data yet.
- Government SSO integration — custom JWT only, no real government
  identity provider integration.
- Rate limiting / WAF — none in front of any service.
- Formal penetration test — not performed.
- ANPR camera-id mapping — live/simulated feeds not yet tied to the
  real camera registry are mapped to a placeholder `camera_id` for
  testing.
- Real VAHAN/eGujCop/SARTHI credentials — all three government-database
  lookups are wired end-to-end but not actually implemented against a
  real API, since access to any of them requires a formal application
  we don't have. Once granted, this needs its own security review
  (these return real PII/police data, not the placeholder response
  used today).

## Summary

The fundamentals are genuinely solid: role-based access control is
enforced consistently at the route level across both backend services
(not just assumed), the alert audit trail is structurally
tamper-resistant (append-only history, not a mutable status column),
and secrets hygiene is clean with nothing committed to source control.
What's deliberately out of scope for a 5-day hackathon build is
infrastructure-level hardening — transport encryption, rate limiting,
dependency patching, and a real penetration test — none of which
change the application's core access-control logic, but all of which
would be required before this could run against real production
traffic.
