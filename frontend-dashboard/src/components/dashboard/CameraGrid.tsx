"use client";

import React from "react";
import { CameraFeed } from "@/types/stream";
import { FeedCard } from "@/components/dashboard/FeedCard";

interface CameraGridProps {
  feeds: CameraFeed[];
  layout: "grid-4" | "grid-9" | "focus";
  /** Called with a camera's id when its "Focus this camera" button is clicked. */
  onSelectFocus?: (id: string) => void;
  /** True when the registry itself returned zero cameras (vs. filters excluding all of them). */
  registryEmpty?: boolean;
}

export const CameraGrid: React.FC<CameraGridProps> = ({ feeds, layout, onSelectFocus, registryEmpty }) => {
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
        <p className="text-gray-400 text-sm">
          {registryEmpty ? "No cameras are registered yet." : "No cameras match the current filters."}
        </p>
      </div>
    );
  }

  return (
    <div className={`grid gap-5 ${getGridClass()}`}>
      {feeds.map((feed) => (
        <FeedCard
          key={feed.id}
          feed={feed}
          onFocus={onSelectFocus && layout !== "focus" ? () => onSelectFocus(feed.id) : undefined}
          startPlaying={layout === "focus"}
        />
      ))}
    </div>
  );
};
