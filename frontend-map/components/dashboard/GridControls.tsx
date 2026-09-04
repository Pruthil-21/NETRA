"use client";

import React from "react";
import { Grid2X2, LayoutGrid, Maximize2, Search } from "lucide-react";
import { CameraFeed } from "@/types/stream";

type StatusFilter = CameraFeed["status"] | "all";

interface GridControlsProps {
  layout: "grid-4" | "grid-9" | "focus";
  setLayout: (layout: "grid-4" | "grid-9" | "focus") => void;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  departments: string[];
  departmentFilter: string;
  setDepartmentFilter: (dept: string) => void;
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

export const GridControls: React.FC<GridControlsProps> = ({
  layout,
  setLayout,
  searchTerm,
  setSearchTerm,
  departments,
  departmentFilter,
  setDepartmentFilter,
  statusFilter,
  setStatusFilter,
  playAllMode,
  setPlayAllMode,
}) => {
  return (
    <div className="flex flex-col lg:flex-row gap-4 justify-between items-center mb-6 bg-brand-card p-4 rounded-lg border border-brand-border">
      <div className="flex flex-col sm:flex-row gap-3 w-full lg:w-auto">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name, ID, or location..."
            aria-label="Search cameras by name, ID, or location"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-gray-900 border border-brand-border rounded-md text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        <select
          value={departmentFilter}
          onChange={(e) => setDepartmentFilter(e.target.value)}
          aria-label="Filter by department"
          className="w-full sm:w-48 py-2 px-3 bg-gray-900 border border-brand-border rounded-md text-sm text-gray-200 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All departments</option>
          {departments.map((dept) => (
            <option key={dept} value={dept}>
              {dept}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by connectivity status"
          className="w-full sm:w-40 py-2 px-3 bg-gray-900 border border-brand-border rounded-md text-sm text-gray-200 focus:outline-none focus:border-blue-500"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center space-x-2">
        <span className="text-xs text-gray-400 mr-2 font-medium">Layout:</span>
        <button
          onClick={() => setLayout("focus")}
          aria-label="Focus mode: one large camera"
          title="Focus Mode (1 Large)"
          className={`p-2 rounded ${layout === "focus" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <button
          onClick={() => setLayout("grid-4")}
          aria-label="2x2 grid layout"
          title="2x2 Matrix"
          className={`p-2 rounded ${layout === "grid-4" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
        >
          <Grid2X2 className="w-4 h-4" />
        </button>
        <button
          onClick={() => setLayout("grid-9")}
          aria-label="3x3 grid layout"
          title="3x3 Matrix"
          className={`p-2 rounded ${layout === "grid-9" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
        <div className="h-5 w-px bg-brand-border mx-1" />
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={playAllMode}
            onChange={(e) => setPlayAllMode(e.target.checked)}
            className="accent-blue-600 w-3.5 h-3.5"
          />
          Play All
        </label>
      </div>
    </div>
  );
};
