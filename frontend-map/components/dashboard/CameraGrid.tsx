"use client";

import React from "react";
import { CameraFeed } from "@/types/stream";
import { FeedCard } from "@/components/dashboard/FeedCard";

interface CameraGridProps {
  feeds: CameraFeed[];
  layout: "grid-4" | "grid-9" | "focus";
  onSelectFocus?: (id: string) => void;
  registryEmpty?: boolean;
  mode: 'playAll' | 'hoverOnly';
  activeIds: Set<string>;
  onHoverStart: (id: string) => void;
  onHoverEnd: (id: string) => void;
}

export const CameraGrid: React.FC<CameraGridProps> = ({
  feeds, layout, onSelectFocus, registryEmpty, mode, activeIds, onHoverStart, onHoverEnd,
}) => {
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
          onFocus={layout !== "focus" ? onSelectFocus : undefined}
          startPlaying={layout === "focus"}
          mode={layout === "focus" ? 'playAll' : mode}
          isPlaying={layout === "focus" ? true : activeIds.has(feed.id)}
          onHoverStart={onHoverStart}
          onHoverEnd={onHoverEnd}
        />
      ))}
    </div>
  );
};
