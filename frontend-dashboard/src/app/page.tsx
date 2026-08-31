"use client";

import React, { useMemo, useState } from "react";
import { Header, SystemStatus } from "@/components/common/Header";
import { CameraGrid } from "@/components/dashboard/CameraGrid";
import { GridControls } from "@/components/dashboard/GridControls";
import { AlertLog } from "@/components/dashboard/AlertLog";
import { AlertBanner, Alert } from "@/components/AlertBanner";
import { useCameraFeeds } from "@/hooks/useCameraFeeds";
import { CameraFeed } from "@/types/stream";
import { TEST_FEEDS } from "@/config/streams";

type StatusFilter = CameraFeed["status"] | "all";

export default function Home() {
  const { feeds, loading, error, refetch } = useCameraFeeds();
  const [layout, setLayout] = useState<"grid-4" | "grid-9" | "focus">("grid-9");
  const [searchTerm, setSearchTerm] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [alertsOk, setAlertsOk] = useState(true);
  const [allAlerts, setAllAlerts] = useState<Alert[]>([]);

  // TEST_FEEDS are manually-verified streams that aren't in backend-registry yet —
  // shown regardless of registry health, since verifying one specific stream shouldn't
  // depend on the registry being up.
  const allFeeds = useMemo(() => [...feeds, ...TEST_FEEDS], [feeds]);

  const departments = useMemo(
    () => Array.from(new Set(allFeeds.map((f) => f.department))).sort(),
    [allFeeds]
  );

  const filteredFeeds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return allFeeds.filter((feed) => {
      if (departmentFilter !== "all" && feed.department !== departmentFilter) return false;
      if (statusFilter !== "all" && feed.status !== statusFilter) return false;
      if (!term) return true;
      return (
        feed.name.toLowerCase().includes(term) ||
        feed.id.toLowerCase().includes(term) ||
        feed.location.toLowerCase().includes(term) ||
        feed.department.toLowerCase().includes(term)
      );
    });
  }, [allFeeds, searchTerm, departmentFilter, statusFilter]);

  // Focus mode shows exactly one camera — the one explicitly picked via a FeedCard's
  // "Focus this camera" button, an alert's "View Camera"/plate link, or the first
  // filtered result if none was picked yet.
  const visibleFeeds = useMemo(() => {
    if (layout !== "focus") return filteredFeeds;
    const focused = filteredFeeds.find((f) => f.id === focusedId);
    return focused ? [focused] : filteredFeeds.slice(0, 1);
  }, [layout, filteredFeeds, focusedId]);

  const handleSelectFocus = (id: string) => {
    setFocusedId(id);
    setLayout("focus");
    // Clear filters so jumping to a camera from an alert always works, even if the
    // alert fired on a camera the current department/status/search filters would
    // otherwise exclude.
    setDepartmentFilter("all");
    setStatusFilter("all");
    setSearchTerm("");
  };

  const systemStatus: SystemStatus = loading ? "connecting" : !error && alertsOk ? "operational" : "degraded";

  return (
    <div className="min-h-screen flex flex-col">
      <Header status={systemStatus} />
      <AlertBanner onConnectionChange={setAlertsOk} onAlertsUpdate={setAllAlerts} onJumpToCamera={handleSelectFocus} />
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold text-white">Live Operations Feeds</h2>
            <p className="text-xs text-gray-400">
              {loading
                ? "Connecting to camera registry..."
                : `${feeds.length} camera${feeds.length === 1 ? "" : "s"} registered`}
            </p>
          </div>
        </div>

        <AlertLog alerts={allAlerts} onJumpToCamera={handleSelectFocus} />

        <GridControls
          layout={layout}
          setLayout={setLayout}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          departments={departments}
          departmentFilter={departmentFilter}
          setDepartmentFilter={setDepartmentFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />

        {loading && (
          <div className="flex items-center justify-center p-12 text-gray-400 text-sm">
            Loading camera feeds...
          </div>
        )}

        {!loading && error && (
          <div className="bg-brand-card border border-red-800/60 text-red-400 p-4 rounded-lg mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-sm">Camera registry unavailable</p>
              <p className="text-xs text-gray-400 mt-1">{error}</p>
            </div>
            <button
              onClick={refetch}
              className="shrink-0 px-3 py-1.5 rounded bg-red-900/60 hover:bg-red-900 text-red-200 text-xs font-semibold transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Rendered even when the registry errored — TEST_FEEDS (and any previously
            fetched real feeds) shouldn't disappear just because the registry is down;
            the error banner above already communicates that separately. */}
        {!loading && (
          <CameraGrid
            feeds={visibleFeeds}
            layout={layout}
            onSelectFocus={handleSelectFocus}
            registryEmpty={allFeeds.length === 0}
          />
        )}
      </main>
    </div>
  );
}
