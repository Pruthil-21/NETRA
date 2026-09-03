"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Alert } from "@/components/AlertBanner";

interface AlertLogProps {
  alerts: Alert[];
  onJumpToCamera: (cameraId: string) => void;
}

const STATUS_STYLE: Record<string, string> = {
  NEW: "text-red-400",
  ACKNOWLEDGED: "text-emerald-400",
  ESCALATED: "text-amber-400",
  DISMISSED: "text-gray-500",
};

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/**
 * The live banner is transient by design — once an alert's dismissed/acknowledged it's
 * gone from view, and an officer who stepped away for a minute has no way to see what
 * happened while they were gone. This renders the same polled alert list (all statuses,
 * not just NEW) as a persistent, collapsible log instead of inventing separate local
 * history — it's the real backend record, so it stays correct even if someone else
 * acted on an alert from a different session.
 */
export function AlertLog({ alerts, onJumpToCamera }: AlertLogProps) {
  const [open, setOpen] = useState(false);
  const sorted = [...alerts].sort(
    (a, b) => new Date(b.matched_at).getTime() - new Date(a.matched_at).getTime()
  );

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg mb-6 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-900/40"
        aria-expanded={open}
      >
        <span className="font-semibold">Alert Log ({sorted.length})</span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-brand-border divide-y divide-brand-border">
          {sorted.length === 0 && (
            <p className="text-xs text-gray-500 px-4 py-3">No alerts recorded yet.</p>
          )}
          {sorted.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-2 text-xs">
              <div className="flex items-center gap-3">
                <span className={`font-semibold w-24 ${STATUS_STYLE[a.status] || "text-gray-400"}`}>{a.status}</span>
                <span className="font-mono text-gray-300">{a.plate_number}</span>
                <button onClick={() => onJumpToCamera(String(a.camera_id))} className="text-blue-400 hover:underline">
                  Camera {a.camera_id}
                </button>
              </div>
              <span className="text-gray-500">{timeAgo(a.matched_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
