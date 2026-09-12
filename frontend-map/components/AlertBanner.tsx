"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, AlertTriangle, ChevronLeft, ChevronRight, X, Film } from "lucide-react";
import { alertsService } from "@/services/alertsService";
import type { Alert, AlertStatus } from "@/types/alert";

export type { Alert };

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters)}m`;
}

interface AlertBannerProps {
  /** Reported after every poll so the page header can reflect real alerts-API health. */
  onConnectionChange?: (ok: boolean) => void;
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function exactTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** A floating overlay, not a permanent fixture -- fixed-positioned just
 * below the app header so it never pushes page content around when it
 * shows or hides. Pops up for a NEW watchlist match, stays out of the way
 * (an X closes it locally) until the next genuinely new one arrives.
 * Multiple pending alerts page through via the arrows rather than each
 * silently overwriting the last, newest first. */
export function AlertBanner({ onConnectionChange }: AlertBannerProps = {}) {
  const router = useRouter();
  const [alertQueue, setAlertQueue] = useState<Alert[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Closed locally by the X -- distinct from the alert's own status. Reset
  // to false whenever a genuinely new alert arrives, so a real event always
  // resurfaces the overlay even if an officer closed it a minute ago.
  const [closed, setClosed] = useState(false);
  // Dismiss is the one action that reads as final (Acknowledge/Escalate
  // leave the alert open to further action) and the backend requires a
  // reason for it -- same rule the Alerts page enforces, kept in sync here
  // rather than this banner silently sending no reason and having the
  // PATCH rejected (which used to advance the queue as if it had worked).
  const [showDismissForm, setShowDismissForm] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  // Previously a failed poll only went to console.warn/error -- an officer
  // watching the actual page had no way to know the alerts feed was down at
  // all, since this component renders nothing when there's no active alert.
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const alerts = await alertsService.list();
        setPollError(null);
        onConnectionChange?.(true);

        setSeenIds((prevSeen) => {
          const newAlerts = alerts.filter((a) => a.status === "NEW" && !prevSeen.has(a.id));
          if (newAlerts.length === 0) return prevSeen;

          // Newest first -- an officer should see the most recent match by
          // default, not whichever happened to be oldest in a large backlog.
          setAlertQueue((prevQueue) =>
            [...prevQueue, ...newAlerts].sort(
              (a, b) => new Date(b.matched_at).getTime() - new Date(a.matched_at).getTime()
            )
          );
          setActiveIndex(0);
          setClosed(false);

          const nextSeen = new Set(prevSeen);
          newAlerts.forEach((a) => nextSeen.add(a.id));
          return nextSeen;
        });
      } catch (err) {
        console.error("Failed to poll alerts:", err);
        const message = err instanceof Error ? err.message : "unknown error";
        setPollError(
          message.includes("401") || message.toLowerCase().includes("not authorized")
            ? "Not authorized — log in again to receive alerts."
            : "Alerts feed unreachable — retrying…"
        );
        onConnectionChange?.(false);
      }
    };

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 3000);
    return () => clearInterval(interval);
    // onConnectionChange is expected to be a stable setter from the parent;
    // re-running this poll loop on every parent render would restart it pointlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the pointer in range as the queue shrinks (an action removes the
  // one currently shown) or grows (a new arrival is spliced in at index 0).
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, alertQueue.length - 1)));
  }, [alertQueue.length]);

  const activeAlert = alertQueue[activeIndex] ?? null;

  // Any pending confirm/reason-entry is scoped to whichever alert asked for
  // it -- once the queue advances or the pointer moves to a different
  // alert, leftover form state belongs to something no longer on screen.
  const activeAlertId = activeAlert?.id;
  useEffect(() => {
    setShowDismissForm(false);
    setDismissReason("");
    setActionError(null);
  }, [activeAlertId]);

  const handleAction = async (status: AlertStatus, reasonCode?: string) => {
    if (!activeAlert || actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      await alertsService.updateStatus(activeAlert.id, status, reasonCode);
      setAlertQueue((prev) => prev.filter((a) => a.id !== activeAlert.id));
      setActiveIndex(0);
      setShowDismissForm(false);
      setDismissReason("");
    } catch (err) {
      // Deliberately does NOT advance the queue on failure -- the previous
      // version did, which meant a rejected PATCH (e.g. Dismiss with no
      // reason) looked like it had succeeded.
      setActionError(err instanceof Error ? err.message : `Failed to update alert ${activeAlert.id}`);
    } finally {
      setActionPending(false);
    }
  };

  // An alert is inherently retrospective -- by the time an officer sees it,
  // the plate is long gone from the live feed. Recorded footage of the
  // actual detection is far more useful than the live view, so this jumps
  // to Archive seeked to ~10s before the exact match instant (Archive's own
  // ?at= convention -- see app/archive/page.tsx) rather than the dashboard.
  const viewFootage = (alert: Alert) => {
    router.push(`/archive?camera=${alert.camera_id}&at=${encodeURIComponent(alert.matched_at)}`);
  };

  const confirmDismiss = () => {
    const reason = dismissReason.trim();
    if (!reason) {
      setActionError("A reason is required to dismiss an alert.");
      return;
    }
    handleAction("DISMISSED", reason);
  };

  if (!activeAlert || closed) {
    if (!pollError) return null;
    // Visible even with no active alert -- a dead feed is exactly the kind
    // of failure an officer can't tell apart from "quiet shift" otherwise.
    return (
      <div className="fixed top-14 inset-x-0 z-[1500] bg-amber-900/90 text-amber-200 px-4 py-2 flex items-center gap-2 text-xs font-medium shadow-lg">
        <AlertTriangle size={14} className="shrink-0" />
        {pollError}
      </div>
    );
  }

  const queuedCount = alertQueue.length;

  return (
    <div className="fixed top-14 inset-x-0 z-[1500] px-3 pt-3 pointer-events-none">
      <div className="pointer-events-auto max-w-3xl mx-auto rounded-lg border border-line bg-panel shadow-2xl border-l-4 border-l-signal-red overflow-hidden">
        <div className="px-4 py-3 flex items-start gap-3">
          <ShieldAlert size={18} className="text-signal-red shrink-0 mt-0.5" />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-wider text-signal-red uppercase">
              Watchlist Match
              {queuedCount > 1 && (
                <span className="text-slate-500 font-normal tracking-normal">
                  {activeIndex + 1} of {queuedCount}
                </span>
              )}
            </div>
            <p className="text-sm text-white mt-0.5">
              Plate <span className="underline font-mono">{activeAlert.plate_number}</span> matched at Camera{" "}
              <button
                onClick={() => viewFootage(activeAlert)}
                className="font-semibold underline decoration-dotted hover:text-command"
              >
                {activeAlert.camera_id}
              </button>
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {timeAgo(activeAlert.matched_at)} &middot; {exactTimestamp(activeAlert.matched_at)}
              {activeAlert.nearest_station && (
                <>
                  {" "}
                  &middot; Nearest station: {activeAlert.nearest_station.name} (
                  {formatDistance(activeAlert.nearest_station.distance_meters)})
                </>
              )}
            </p>

            {actionError && <p className="text-[11px] text-signal-red mt-1.5">{actionError}</p>}

            {showDismissForm ? (
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  autoFocus
                  value={dismissReason}
                  onChange={(e) => {
                    setDismissReason(e.target.value);
                    setActionError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && confirmDismiss()}
                  placeholder="Reason for dismissing (required)"
                  className="flex-1 bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
                />
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={confirmDismiss}
                  className="px-2.5 py-1.5 rounded text-xs font-semibold bg-signal-red hover:bg-signal-red/80 text-white disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDismissForm(false);
                    setDismissReason("");
                    setActionError(null);
                  }}
                  className="px-2 py-1.5 rounded text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="mt-2.5 flex items-center gap-2">
                {/* One clear primary action (solid fill) and everything else
                    outlined -- four equally-loud solid buttons all competing
                    for attention was itself part of what made this overlay
                    hard to read at a glance. */}
                <button
                  disabled={actionPending}
                  onClick={() => handleAction("ACKNOWLEDGED")}
                  title="Seen — I'm handling this"
                  className="px-3 py-1.5 rounded text-xs font-semibold bg-signal-green text-white hover:bg-signal-green/90 disabled:opacity-50"
                >
                  Acknowledge
                </button>
                <button
                  disabled={actionPending}
                  onClick={() => handleAction("ESCALATED")}
                  title="Needs backup / higher priority"
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-signal-amber text-signal-amber hover:bg-signal-amber/15 disabled:opacity-50"
                >
                  Escalate
                </button>
                <button
                  disabled={actionPending}
                  onClick={() => setShowDismissForm(true)}
                  title="False positive / not actionable"
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-signal-red/60 text-signal-red hover:bg-signal-red/15 disabled:opacity-50"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => viewFootage(activeAlert)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-slate-400 hover:text-white"
                >
                  <Film size={12} />
                  View Footage
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {queuedCount > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous alert"
                  onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
                  disabled={activeIndex === 0}
                  className="p-1 rounded text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Next alert"
                  onClick={() => setActiveIndex((i) => Math.min(queuedCount - 1, i + 1))}
                  disabled={activeIndex === queuedCount - 1}
                  className="p-1 rounded text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500"
                >
                  <ChevronRight size={16} />
                </button>
              </>
            )}
            <button
              type="button"
              aria-label="Close alert overlay"
              onClick={() => setClosed(true)}
              className="p-1 rounded text-slate-500 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
