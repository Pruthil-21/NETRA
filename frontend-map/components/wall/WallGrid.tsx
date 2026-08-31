'use client';

import React from 'react';
import { Camera } from '@/types/camera';
import { WallFeedCard } from '@/components/wall/WallFeedCard';

export type WallLayout = 'focus' | 'grid-4' | 'grid-9';

const LAYOUT_CLASSES: Record<WallLayout, string> = {
  focus: 'grid-cols-1 max-w-4xl mx-auto',
  'grid-4': 'grid-cols-1 md:grid-cols-2',
  'grid-9': 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
};

export function WallGrid({ cameras, layout }: { cameras: Camera[]; layout: WallLayout }) {
  if (cameras.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-line rounded">
        <p className="text-slate-500 text-xs">No cameras match your search.</p>
      </div>
    );
  }

  return (
    <div className={`grid gap-4 ${LAYOUT_CLASSES[layout]}`}>
      {cameras.map((camera) => (
        <WallFeedCard key={camera.id} camera={camera} />
      ))}
    </div>
  );
}

export default WallGrid;
