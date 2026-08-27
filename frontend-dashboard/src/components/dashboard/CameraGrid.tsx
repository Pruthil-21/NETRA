"use client";

import React from "react";
import { CameraFeed } from "@/types/stream";
import { FeedCard } from "@/components/dashboard/FeedCard";

interface CameraGridProps {
  feeds: CameraFeed[];
  layout: "grid-4" | "grid-9" | "focus";
}

export const CameraGrid: React.FC<CameraGridProps> = ({ feeds, layout }) => {
  const getGridClass = () => {
    switch (layout) {
      case "focus":
        return "grid-cols-1 max-w-4xl mx-auto";
      case "grid-4":
        return "grid-cols-1 md:grid-cols-2";
      case "grid-9":
      default:
        return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
    }
  };

  if (feeds.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed border-gray-800 rounded-lg">
        <p className="text-gray-400 text-sm">No cameras match the search filter.</p>
      </div>
    );
  }

  return (
    <div className={`grid gap-5 ${getGridClass()}`}>
      {feeds.map((feed) => (
        <FeedCard key={feed.id} feed={feed} />
      ))}
    </div>
  );
};