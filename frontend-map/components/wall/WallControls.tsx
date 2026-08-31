'use client';

import React from 'react';
import { Grid2X2, LayoutGrid, Maximize2, Search } from 'lucide-react';
import { WallLayout } from '@/components/wall/WallGrid';

const LAYOUT_OPTIONS: { value: WallLayout; label: string; icon: typeof Maximize2 }[] = [
  { value: 'focus', label: 'Focus — one large feed', icon: Maximize2 },
  { value: 'grid-4', label: '2×2 grid', icon: Grid2X2 },
  { value: 'grid-9', label: '3×3 grid', icon: LayoutGrid },
];

export function WallControls({
  layout,
  setLayout,
  searchTerm,
  setSearchTerm,
}: {
  layout: WallLayout;
  setLayout: (layout: WallLayout) => void;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between mb-4">
      <div className="relative w-full sm:w-72">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          placeholder="Search by name, ID, or location…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-panel border border-line rounded pl-8 pr-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-command"
        />
      </div>

      <div role="group" aria-label="Wall layout" className="flex items-center gap-1.5">
        {LAYOUT_OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setLayout(value)}
            aria-label={label}
            aria-pressed={layout === value}
            title={label}
            className={`p-1.5 rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command ${
              layout === value
                ? 'bg-command border-command text-white'
                : 'bg-panel-raised border-line text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default WallControls;
