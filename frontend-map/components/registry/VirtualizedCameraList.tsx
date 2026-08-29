'use client';

import React, { useRef, useState, useCallback, useMemo } from 'react';
import { Camera } from '@/types/camera';
import CameraCard from './CameraCard';

// Bulk import can add hundreds of cameras — rendering every CameraCard at
// once would mean hundreds of live DOM nodes just to show a scrollable list,
// which is exactly the kind of jank a live command console can't afford.
// This windows the list to only what's near the viewport, with a fixed row
// height (measured from CameraCard's actual padding/line-height) so the math
// stays simple and cheap on every scroll event.
const ROW_HEIGHT = 61;
const OVERSCAN = 8;

interface VirtualizedCameraListProps {
  cameras: Camera[];
  selectedCamera: Camera | null;
  onSelect: (cam: Camera) => void;
}

export default function VirtualizedCameraList({ cameras, selectedCamera, onSelect }: VirtualizedCameraListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  const { startIndex, endIndex, topPad, bottomPad } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(cameras.length, first + visibleCount);
    return {
      startIndex: first,
      endIndex: last,
      topPad: first * ROW_HEIGHT,
      bottomPad: (cameras.length - last) * ROW_HEIGHT,
    };
  }, [scrollTop, viewportHeight, cameras.length]);

  const visible = cameras.slice(startIndex, endIndex);

  return (
    <div ref={measureRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      <div style={{ height: topPad }} />
      {visible.map((cam) => (
        <CameraCard
          key={cam.id}
          camera={cam}
          isSelected={selectedCamera?.id === cam.id}
          onSelect={() => onSelect(cam)}
        />
      ))}
      <div style={{ height: bottomPad }} />
    </div>
  );
}
