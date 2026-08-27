// components/registry/CameraListSkeleton.tsx
import React from 'react';

export const CameraListSkeleton: React.FC = () => {
  return (
    <div className="p-3 space-y-3 animate-pulse">
      {[1, 2, 3, 4, 5].map((item) => (
        <div
          key={item}
          className="p-3 bg-slate-900/60 border border-slate-800/80 rounded-lg space-y-2.5"
        >
          <div className="flex justify-between items-center">
            <div className="h-3.5 bg-slate-800 rounded w-1/2"></div>
            <div className="h-2.5 bg-slate-800 rounded-full w-12"></div>
          </div>
          <div className="h-2.5 bg-slate-800/70 rounded w-3/4"></div>
          <div className="flex gap-2 pt-1">
            <div className="h-2 bg-slate-800/50 rounded w-1/4"></div>
            <div className="h-2 bg-slate-800/50 rounded w-1/4"></div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default CameraListSkeleton;