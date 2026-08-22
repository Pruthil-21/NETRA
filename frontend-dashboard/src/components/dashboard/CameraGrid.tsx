import React from "react";
import { CameraFeed } from "@/types/stream";
import { FeedCard } from "@/components/dashboard/FeedCard";

interface CameraGridProps {
  feeds: CameraFeed[];
}

export const CameraGrid: React.FC<CameraGridProps> = ({ feeds }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {feeds.map((feed) => (
        <FeedCard key={feed.id} feed={feed} />
      ))}
    </div>
  );
};
