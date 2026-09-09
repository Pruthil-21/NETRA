"""Read-only reporting: coverage gap analysis and the platform-wide summary
dashboard."""
import psycopg
from fastapi import APIRouter, Depends

from ..auth import get_current_user
from ..db import get_conn
from ..logging_config import logger
from ..schemas import GapAnalysisReport, ReportSummary
from ..services import gap_analysis_service, reports_service

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/gap-analysis", response_model=GapAnalysisReport)
def gap_analysis_report(
    threshold_m: int = 100,
    age_threshold_days: int = 1095,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
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
        return {"uncovered_zones": uncovered, "ageing_infrastructure": ageing}


@router.get("/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary
