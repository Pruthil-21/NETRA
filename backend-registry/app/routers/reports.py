"""Read-only reporting: coverage gap analysis and the platform-wide summary
dashboard."""
from datetime import datetime, timezone
from html import escape

import psycopg
from fastapi import APIRouter, Depends, Response

from ..auth import get_current_user
from ..db import get_conn
from ..logging_config import logger
from ..schemas import GapAnalysisReport, ReportSummary
from ..services import gap_analysis_service, reports_service

router = APIRouter(prefix="/reports", tags=["reports"])


def _compute_gap_analysis(conn, threshold_m: int, age_threshold_days: int, budget: int) -> dict:
    try:
        uncovered = gap_analysis_service.compute_uncovered_zones(conn, threshold_m)
    except psycopg.Error:
        conn.rollback()
        logger.error("gap-analysis: uncovered-zones computation failed", exc_info=True)
        uncovered = []
    try:
        ageing = gap_analysis_service.compute_ageing_infrastructure(conn, age_threshold_days)
    except psycopg.Error:
        conn.rollback()
        logger.error("gap-analysis: ageing-infrastructure computation failed", exc_info=True)
        ageing = []
    try:
        placements = gap_analysis_service.suggest_camera_placements(conn, threshold_m, budget)
    except psycopg.Error:
        conn.rollback()
        logger.error("gap-analysis: placement-suggestion computation failed", exc_info=True)
        placements = []
    return {"uncovered_zones": uncovered, "ageing_infrastructure": ageing, "placement_suggestions": placements}


@router.get("/gap-analysis", response_model=GapAnalysisReport)
def gap_analysis_report(
    threshold_m: int = 100,
    age_threshold_days: int = 1095,
    placement_budget: int = 5,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        return _compute_gap_analysis(conn, threshold_m, age_threshold_days, placement_budget)


def _report_html(report: dict, threshold_m: int, age_threshold_days: int) -> str:
    """A self-contained, printable HTML report -- the Expected Deliverable
    Model 1's spec names ("Sample gap-analysis report") as an artifact, not
    raw JSON. Same "turn a computed result into something a commander
    actually wants to read" idea as Google Lighthouse/SSL Labs reports:
    plain inline CSS, no external assets/build step, opens and prints
    correctly offline from a single saved .html file."""
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    zones = report["uncovered_zones"]
    ageing = report["ageing_infrastructure"]
    placements = report["placement_suggestions"]

    def zone_row(z: dict) -> str:
        dist = f"{z['distance_meters']:.0f} m" if z["distance_meters"] is not None else "no camera nearby"
        return (
            f"<tr><td>{escape(z['name'])}</td><td>{escape(z['district'])}</td>"
            f"<td class='badge badge-{escape(z['priority'])}'>{escape(z['priority'])}</td>"
            f"<td>{dist}</td></tr>"
        )

    def ageing_row(a: dict) -> str:
        return (
            f"<tr><td>{escape(a['name'])}</td><td>{escape(a['district'])}</td>"
            f"<td>{a['age_days']} days</td><td>{a['degraded_transition_count_90d']}</td>"
            f"<td class='badge badge-risk-{escape(a['risk_level'])}'>{escape(a['risk_level'])}</td></tr>"
        )

    def placement_row(p: dict) -> str:
        return (
            f"<tr><td>{escape(p['suggested_at_name'])}</td><td>{escape(p['district'])}</td>"
            f"<td>{p['lat']:.5f}, {p['long']:.5f}</td>"
            f"<td>{len(p['covers_target_ids'])}</td><td>{p['priority_weighted_score']:.0f}</td></tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>DIGDHRISHTI — CCTV Coverage Gap Analysis</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 32px;
         color: #1a2332; background: #f4f6f8; }}
  .sheet {{ max-width: 980px; margin: 0 auto; background: #fff; border-radius: 10px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 40px 48px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; color: #0b3d91; }}
  .subtitle {{ color: #5a6b7d; font-size: 13px; margin-bottom: 28px; }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #0b3d91;
        border-bottom: 2px solid #e4e9ef; padding-bottom: 6px; margin-top: 36px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }}
  th {{ text-align: left; background: #eef2f7; padding: 8px 10px; font-weight: 600; color: #35435a; }}
  td {{ padding: 7px 10px; border-bottom: 1px solid #eef1f4; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }}
  .badge-high {{ background: #fde2e1; color: #a3231e; }}
  .badge-medium {{ background: #fdf1d8; color: #97650c; }}
  .badge-low {{ background: #e3f0ff; color: #1c5fa8; }}
  .badge-risk-high {{ background: #fde2e1; color: #a3231e; }}
  .badge-risk-medium {{ background: #fdf1d8; color: #97650c; }}
  .badge-risk-low {{ background: #e6f4e8; color: #1c7a37; }}
  .empty {{ color: #8a97a6; font-style: italic; font-size: 13px; padding: 10px 0; }}
  .stat-row {{ display: flex; gap: 16px; margin-top: 8px; }}
  .stat {{ flex: 1; background: #f7f9fb; border-radius: 8px; padding: 14px 16px; }}
  .stat .n {{ font-size: 24px; font-weight: 700; color: #0b3d91; }}
  .stat .l {{ font-size: 12px; color: #5a6b7d; }}
  footer {{ margin-top: 40px; font-size: 11px; color: #9aa7b3; }}
  @media print {{ body {{ background: #fff; padding: 0; }} .sheet {{ box-shadow: none; }} }}
</style></head>
<body><div class="sheet">
  <h1>CCTV Coverage Gap Analysis</h1>
  <div class="subtitle">Generated {generated_at} &middot; coverage threshold {threshold_m} m
    &middot; ageing threshold {age_threshold_days} days</div>

  <div class="stat-row">
    <div class="stat"><div class="n">{len(zones)}</div><div class="l">Uncovered checkpoints</div></div>
    <div class="stat"><div class="n">{len(ageing)}</div><div class="l">Ageing / at-risk cameras</div></div>
    <div class="stat"><div class="n">{len(placements)}</div><div class="l">Suggested new sites</div></div>
  </div>

  <h2>Recommended new-camera placements</h2>
  {"<table><tr><th>Suggested site</th><th>District</th><th>Coordinates</th>"
   "<th>Checkpoints closed</th><th>Priority score</th></tr>"
   + "".join(placement_row(p) for p in placements) + "</table>"
   if placements else "<div class='empty'>No uncovered checkpoints to suggest sites for.</div>"}

  <h2>Uncovered checkpoints</h2>
  {"<table><tr><th>Checkpoint</th><th>District</th><th>Priority</th><th>Nearest camera</th></tr>"
   + "".join(zone_row(z) for z in zones) + "</table>"
   if zones else "<div class='empty'>Every checkpoint has camera coverage within threshold.</div>"}

  <h2>Ageing / at-risk infrastructure</h2>
  {"<table><tr><th>Camera</th><th>District</th><th>Age</th>"
   "<th>Offline/degraded (90d)</th><th>Risk</th></tr>"
   + "".join(ageing_row(a) for a in ageing) + "</table>"
   if ageing else "<div class='empty'>No cameras past the age threshold with a connectivity history.</div>"}

  <footer>DIGDHRISHTI Registry &mdash; Model 1 (Registry &amp; GIS Foundation) gap-analysis export.
    Placement suggestions use a greedy set-cover heuristic weighted by checkpoint priority, not a
    guaranteed-optimal solve. Risk levels are derived from age and connectivity history only, not
    predictive failure modeling.</footer>
</div></body></html>"""


@router.get("/gap-analysis/export")
def gap_analysis_report_export(
    threshold_m: int = 100,
    age_threshold_days: int = 1095,
    placement_budget: int = 5,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        report = _compute_gap_analysis(conn, threshold_m, age_threshold_days, placement_budget)
    html = _report_html(report, threshold_m, age_threshold_days)
    return Response(
        content=html,
        media_type="text/html",
        headers={"Content-Disposition": "inline; filename=gap-analysis-report.html"},
    )


@router.get("/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary
