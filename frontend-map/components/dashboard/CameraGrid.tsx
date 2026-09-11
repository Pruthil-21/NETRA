"use client";

import React from "react";
import { CameraFeed } from "@/types/stream";
import { FeedCard } from "@/components/dashboard/FeedCard";
import { useCameraDropTarget } from "@/hooks/useCameraDropTarget";
import { useBestFitTileSize } from "@/hooks/useBestFitTileSize";

interface CameraGridProps {
  feeds: CameraFeed[];
  layout: "grid-4" | "grid-9";
  registryEmpty?: boolean;
  mode: 'playAll' | 'hoverOnly';
  activeIds: Set<string>;
  onHoverStart: (id: string) => void;
  onHoverEnd: (id: string) => void;
  /** Present only when tiles can be dragged into a new order -- see FeedCard. */
  onReorder?: (draggedId: string, targetId: string) => void;
  /** Present only when this grid can receive cameras dragged in from
   * DistrictAreaTree -- called with every dropped camera id (one for a
   * single camera row, several for a district/area row). */
  onDropCameraIds?: (cameraIds: number[]) => void;
  /** True for a drag-composed watch set -- replaces the fixed grid-4/grid-9
   * layouts with a measured best-fit tile wall (see useBestFitTileSize):
   * tiles stay close to a real camera's 16:9 shape and fill exactly the
   * available screen space, with an incomplete last row centered instead
   * of left-aligned with a dangling empty gap. */
  immersive?: boolean;
  /** Present only while showing a drag-composed watch set -- lets an
   * officer pull one stream back out without clearing the whole set. */
  onRemove?: (id: string) => void;
}

export const CameraGrid: React.FC<CameraGridProps> = ({
  feeds, layout, registryEmpty, mode, activeIds, onHoverStart, onHoverEnd, onReorder,
  onDropCameraIds, immersive = false, onRemove,
}) => {
  const getGridClass = () => {
    switch (layout) {
      case "grid-4":
        return "grid-cols-1 md:grid-cols-2";
      case "grid-9":
      default:
        return "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";
    }
  };

  const { isOver, dropHandlers } = useCameraDropTarget((ids) => onDropCameraIds?.(ids));
  const isDropEnabled = !!onDropCameraIds;
  const [wallRef, tileSize] = useBestFitTileSize(immersive ? feeds.length : 0);

  const outerClassName = `rounded-lg transition-shadow ${immersive ? "h-full" : ""} ${
    isDropEnabled && isOver ? "ring-2 ring-command ring-offset-2 ring-offset-ink" : ""
  }`;

  if (feeds.length === 0) {
    return (
      <div {...(isDropEnabled ? dropHandlers : {})} className={outerClassName}>
        <div className="text-center py-12 border border-dashed border-gray-800 rounded-lg">
          <p className="text-gray-400 text-sm">
            {registryEmpty
              ? "No cameras are registered yet."
              : isDropEnabled
                ? "No cameras match the current filters — or drag a camera, area, or district from the sidebar to start watching it."
                : "No cameras match the current filters."}
          </p>
        </div>
      </div>
    );
  }

  if (immersive) {
    return (
      <div {...(isDropEnabled ? dropHandlers : {})} className={outerClassName}>
        {/* flex-wrap + centered content (not a CSS grid) is what centers an
            incomplete last row instead of leaving a dangling empty cell on
            one side. gap-0.5 (2px) matches useBestFitTileSize's own GAP_PX --
            a hairline divider between tiles, not a real gutter, same as a
            real VMS video wall (Milestone/Genetec/Hikvision tile cameras
            edge-to-edge with a 1-2px border, not whitespace). */}
        <div ref={wallRef} className="h-full w-full flex flex-wrap content-center justify-center gap-0.5 overflow-hidden">
          {feeds.map((feed) => (
            <div key={feed.id} style={{ width: tileSize.tileWidth || undefined, height: tileSize.tileHeight || undefined }}>
              <FeedCard
                feed={feed}
                mode={mode}
                isPlaying={activeIds.has(feed.id)}
                onHoverStart={onHoverStart}
                onHoverEnd={onHoverEnd}
                onRemove={onRemove}
                immersive
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div {...(isDropEnabled ? dropHandlers : {})} className={outerClassName}>
      <div className={`grid gap-5 ${getGridClass()}`}>
        {feeds.map((feed) => (
          <FeedCard
            key={feed.id}
            feed={feed}
            mode={mode}
            isPlaying={activeIds.has(feed.id)}
            onHoverStart={onHoverStart}
            onHoverEnd={onHoverEnd}
            onReorder={onReorder}
          />
        ))}
      </div>
    </div>
  );
};
