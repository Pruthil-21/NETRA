"use client";

import React from "react";
import { Grid2X2, LayoutGrid } from "lucide-react";
import { CameraFeed } from "@/types/stream";

type StatusFilter = CameraFeed["status"] | "all";

interface GridControlsProps {
  layout: "grid-4" | "grid-9";
  setLayout: (layout: "grid-4" | "grid-9") => void;
  statusFilter: StatusFilter;
  setStatusFilter: (status: StatusFilter) => void;
  playAllMode: boolean;
  setPlayAllMode: (value: boolean) => void;
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ONLINE", label: "Online" },
  { value: "DEGRADED", label: "Degraded" },
  { value: "UNKNOWN", label: "Unconfirmed" },
  { value: "OFFLINE", label: "Offline" },
];

/** Dashboard-only sidebar controls (status filter, grid layout, Play All) --
 * lives inside CameraRegistrySidebar's extraControls slot rather than its
 * own bar across the top of the feed grid, which just pushed every camera
 * tile down for three things an officer sets once per session, not per
 * camera. Free-text search was dropped entirely, not relocated here: the
 * sidebar's own tree search already does that job (narrow-and-select a
 * camera), so this doesn't need to duplicate it. Map/Archive don't render
 * this -- their CameraRegistrySidebar usage omits extraControls, keeping
 * them exactly as they were. */
export const GridControls: React.FC<GridControlsProps> = ({
  layout,
  setLayout,
  statusFilter,
  setStatusFilter,
  playAllMode,
  setPlayAllMode,
}) => {
  return (
    <div className="px-3 py-3 border-b border-line space-y-3">
      <div>
        <label htmlFor="dashboard-status-filter" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1.5">
          Status
        </label>
        <select
          id="dashboard-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by connectivity status"
          className="w-full py-1.5 px-2.5 bg-ink border border-line rounded-md text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-command"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <span className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1.5">Layout</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setLayout("grid-4")}
            aria-label="2x2 grid layout"
            title="2x2 Matrix"
            className={`p-1.5 rounded ${layout === "grid-4" ? "bg-command text-white" : "bg-panel-raised text-slate-400 hover:text-white"}`}
          >
            <Grid2X2 size={14} />
          </button>
          <button
            onClick={() => setLayout("grid-9")}
            aria-label="3x3 grid layout"
            title="3x3 Matrix"
            className={`p-1.5 rounded ${layout === "grid-9" ? "bg-command text-white" : "bg-panel-raised text-slate-400 hover:text-white"}`}
          >
            <LayoutGrid size={14} />
          </button>
          <div className="h-5 w-px bg-line mx-1" />
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={playAllMode}
              onChange={(e) => setPlayAllMode(e.target.checked)}
              className="accent-command w-3.5 h-3.5"
            />
            Play All
          </label>
        </div>
      </div>
    </div>
  );
};
