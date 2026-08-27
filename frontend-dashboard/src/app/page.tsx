"use client";

import React, { useMemo, useState } from "react";
import { Header } from "@/components/common/Header";
import { CameraGrid } from "@/components/dashboard/CameraGrid";
import { GridControls } from "@/components/dashboard/GridControls";
import { AlertBanner } from "@/components/AlertBanner";
import { useCameraFeeds } from "@/hooks/useCameraFeeds";

export default function Home() {
  const { feeds, loading, error } = useCameraFeeds();
  const [layout, setLayout] = useState<"grid-4" | "grid-9" | "focus">("grid-9");
  const [searchTerm, setSearchTerm] = useState("");

  const filteredFeeds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return feeds;
    return feeds.filter(
      (feed) =>
        feed.name.toLowerCase().includes(term) ||
        feed.id.toLowerCase().includes(term) ||
        feed.location.toLowerCase().includes(term) ||
        feed.department.toLowerCase().includes(term)
    );
  }, [feeds, searchTerm]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <AlertBanner />
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

        <GridControls layout={layout} setLayout={setLayout} searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

        {loading && (
          <div className="flex items-center justify-center p-12 text-gray-400 text-sm">
            Loading camera feeds...
          </div>
        )}

        {!loading && error && (
          <div className="bg-brand-card border border-red-800/60 text-red-400 p-4 rounded-lg mb-6">
            <p className="font-semibold text-sm">Camera registry unavailable</p>
            <p className="text-xs text-gray-400 mt-1">{error}</p>
          </div>
        )}

        {!loading && !error && <CameraGrid feeds={filteredFeeds} layout={layout} />}
      </main>
    </div>
  );
}
