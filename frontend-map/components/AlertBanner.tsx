"use client";

import React, { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { WATCHLIST_API_URL } from "@/config/streams";
import { authorizedFetch, describeFetchError } from "@/lib/apiClient";

// ids/camera_id/watchlist_id come back as JSON numbers from backend-watchlist (see
// contract/API_CONTRACT.md's Alert shape) — a prior version of this file typed them as
// strings, which happened to still render fine but would have broken a strict `===`
// comparison against a camera's numeric-looking id.
export interface Alert {
  id: number;
  camera_id: number;
  plate_number: string;
  watchlist_id: number;
  matched_at: string;
  status: "NEW" | "ACKNOWLEDGED" | "DISMISSED" | "ESCALATED" | string;
  // Attached server-side (alerts_service._with_nearest_station) via a real
  // PostGIS distance calculation from the alert's camera -- null only when
  // the environment has zero police_stations rows configured yet.
  nearest_station?: { name: string; distance_meters: number } | null;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters)}m`;
}

type ActionStatus = "ACKNOWLEDGED" | "DISMISSED" | "ESCALATED";

interface AlertBannerProps {
  /** Reported after every poll so the page header can reflect real alerts-API health. */
  onConnectionChange?: (ok: boolean) => void;
  /** Every successful poll's full alert list (all statuses) — feeds a persistent log view. */
  onAlertsUpdate?: (alerts: Alert[]) => void;
  /** Called with a camera id when the officer wants to jump straight to its live feed. */
  onJumpToCamera?: (cameraId: string) => void;
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export function AlertBanner({ onConnectionChange, onAlertsUpdate, onJumpToCamera }: AlertBannerProps = {}) {
  // A queue, not a single slot — two alerts firing within one poll window used to mean
  // the second silently overwrote the first before anyone saw it.
  const [alertQueue, setAlertQueue] = useState<Alert[]>([]);
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());
  const [actionPending, setActionPending] = useState(false);
  // Dismiss reads as final in a way Acknowledge/Escalate don't -- both of those
  // still leave the alert sitting in NEW/ACKNOWLEDGED where it can be acted on
  // again, but Dismiss is the "nothing more to do here" call. One extra click
  // guards against a mis-click on a fast-arriving queue; it reverts on its own
  // if the officer moves on instead of confirming.
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  // Previously a failed poll only went to console.warn/error -- an officer
  // watching the actual page had no way to know the alerts feed was down at
  // all, since this component renders nothing when there's no active alert.
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const res = await authorizedFetch(`${WATCHLIST_API_URL}/alerts`);

        if (!res.ok) {
          const message =
            res.status === 401 || res.status === 403
              ? "Not authorized — log in again to receive alerts."
              : `Alerts feed unavailable (HTTP ${res.status}).`;
          console.warn(`Alerts API returned ${res.status} — check you are logged in with a valid officer session.`);
          setPollError(message);
          onConnectionChange?.(false);
          return;
        }

        const alerts: Alert[] = await res.json();
        setPollError(null);
        onConnectionChange?.(true);
        onAlertsUpdate?.(alerts);

        setSeenIds((prevSeen) => {
          const newAlerts = alerts.filter((a) => a.status === "NEW" && !prevSeen.has(a.id));
          if (newAlerts.length === 0) return prevSeen;

          setAlertQueue((prevQueue) => [...prevQueue, ...newAlerts]);

          const nextSeen = new Set(prevSeen);
          newAlerts.forEach((a) => nextSeen.add(a.id));
          return nextSeen;
        });
      } catch (err) {
        console.error("Failed to poll alerts:", describeFetchError(err, "unknown error"));
        setPollError("Alerts feed unreachable — retrying…");
        onConnectionChange?.(false);
      }
    };

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 3000);
    return () => clearInterval(interval);
    // onConnectionChange/onAlertsUpdate are expected to be stable setters from the
    // parent; re-running this poll loop on every parent render would restart it pointlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeAlert = alertQueue[0] ?? null;
  const queuedCount = alertQueue.length - 1;

  // A pending confirm is scoped to whichever alert asked for it -- once the
  // queue advances (this alert got actioned) or a fresh alert jumps the
  // queue, any leftover "Confirm?" state belongs to an alert that's no
  // longer on screen.
  useEffect(() => {
    setConfirmDismiss(false);
  }, [activeAlert?.id]);

  // Previously "Dismiss" only removed the alert from local browser state — it never
  // told backend-watchlist anything happened. That meant the append-only audit trail
  // (alert_status_history) this system is designed around never actually got written
  // from here: an officer "handling" a match left no record anywhere but their own tab.
  const handleAction = async (status: ActionStatus) => {
    if (!activeAlert || actionPending) return;
    setActionPending(true);
    try {
      const res = await authorizedFetch(`${WATCHLIST_API_URL}/alerts/${activeAlert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        console.warn(`Failed to update alert ${activeAlert.id}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`Failed to update alert ${activeAlert.id}:`, describeFetchError(err, "unknown error"));
    } finally {
      setActionPending(false);
      setAlertQueue((prev) => prev.slice(1));
    }
  };

  if (!activeAlert) {
    if (!pollError) return null;
    // Visible even with no active alert -- a dead feed is exactly the kind
    // of failure an officer can't tell apart from "quiet shift" otherwise.
    return (
      <div className="bg-amber-900/80 text-amber-200 px-4 py-2 flex items-center gap-2 text-xs font-medium w-full">
        <AlertTriangle size={14} className="shrink-0" />
        {pollError}
      </div>
    );
  }

  return (
    <div className="bg-red-600 text-white px-4 py-3 flex flex-wrap justify-between items-center gap-3 shadow-lg w-full">
      <div className="flex-1 min-w-[260px]">
        <span className="font-bold">🚨 ALERT: </span>
        Plate <span className="underline font-mono">{activeAlert.plate_number}</span> matched watchlist at Camera{" "}
        <button
          onClick={() => onJumpToCamera?.(String(activeAlert.camera_id))}
          className="font-semibold underline decoration-dotted hover:text-red-100"
        >
          {activeAlert.camera_id}
        </button>
        <span className="ml-2 text-red-100 text-xs">{timeAgo(activeAlert.matched_at)}</span>
        {activeAlert.nearest_station && (
          <span className="ml-2 text-red-100 text-xs">
            &middot; Nearest station: {activeAlert.nearest_station.name} (
            {formatDistance(activeAlert.nearest_station.distance_meters)})
          </span>
        )}
        {queuedCount > 0 && (
          <span className="ml-2 text-red-100 text-xs font-medium">
            (+{queuedCount} more alert{queuedCount === 1 ? "" : "s"} pending)
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => onJumpToCamera?.(String(activeAlert.camera_id))}
          className="bg-red-950/60 hover:bg-red-950 px-3 py-1 rounded text-xs font-semibold transition-colors"
        >
          View Camera
        </button>
        <button
          disabled={actionPending}
          onClick={() => handleAction("ACKNOWLEDGED")}
          title="Seen — I'm handling this"
          className="bg-emerald-800 hover:bg-emerald-900 px-3 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50"
        >
          Acknowledge
        </button>
        <button
          disabled={actionPending}
          onClick={() => handleAction("ESCALATED")}
          title="Needs backup / higher priority"
          className="bg-amber-700 hover:bg-amber-800 px-3 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50"
        >
          Escalate
        </button>
        <button
          disabled={actionPending}
          onClick={() => {
            if (confirmDismiss) {
              handleAction("DISMISSED");
              return;
            }
            setConfirmDismiss(true);
            setTimeout(() => setConfirmDismiss(false), 4000);
          }}
          title={confirmDismiss ? "Click again to confirm" : "False positive / not actionable"}
          className={`px-3 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50 ${
            confirmDismiss ? "bg-red-950 ring-1 ring-red-300 animate-pulse" : "bg-red-800 hover:bg-red-900"
          }`}
        >
          {confirmDismiss ? "Confirm Dismiss?" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
