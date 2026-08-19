# NETRA

NETRA (Network for Extended Threat Recognition & Analytics) — a unified CCTV registry, viewing, and analytics prototype for Gujarat Govt departments.

## Problem

26 government departments run independent, heterogeneous CCTV infrastructure — different vendors, VMS platforms, storage systems, and retention policies. NETRA provides a unified registry, viewing layer, and analytics pipeline that integrates with existing infrastructure rather than replacing it, with future links to VAHAN, SARTHI, eGujCop, AFIS, and NAFIS.

## Structure

- `contract/` — API contract for all services
- `backend-registry/` — camera registry API, PostGIS
- `frontend-map/` — registry map + filters UI
- `streaming/` — MediaMTX + FFmpeg feed simulation
- `frontend-dashboard/` — live viewing + alerts UI
- `ml-anpr/` — ANPR plate detection
- `backend-watchlist/` — watchlist + alerts API

## Architecture

**Model 1 — Registry:** PostGIS-backed camera database with CRUD APIs, surfaced through a React/Next.js map and filter UI.

**Model 2 — Unified Viewing & Analytics:** Simulated department feeds (FFmpeg → RTSP → MediaMTX) served as HLS (public dashboard) and WebRTC (authorized viewers) from a single ingest, with real-time ANPR plate detection matched against a watchlist to trigger alerts.