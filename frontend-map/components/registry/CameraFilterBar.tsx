// components/registry/CameraFilterBar.tsx
'use client';

import React, { useMemo } from 'react';
import { useCameraRegistry } from '../../context/CameraRegistryContext';
import { Search, RotateCcw, X } from 'lucide-react';

export const CameraFilterBar: React.FC = () => {
  const { cameras, filters, setFilters } = useCameraRegistry();

  const distinctDepts = useMemo(() => {
    const depts = new Set(cameras.map((c) => c.dept).filter(Boolean));
    return ['All Departments', ...Array.from(depts)];
  }, [cameras]);

  const handleReset = () => {
    setFilters({
      department: 'All Departments',
      connectivity: 'all',
      health: 'all',
      searchQuery: '',
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFilters((prev) => ({ ...prev, searchQuery: '' }));
    }
  };

  return (
    <div
      role="search"
      aria-label="Camera filters"
      className="p-3 bg-panel border-b border-line space-y-3"
    >
      {/* Search Input with Keyboard Clear */}
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 pointer-events-none"
        />
        <input
          type="text"
          aria-label="Search cameras by ID, name, or location"
          placeholder="Search by ID, name, location... (Esc to clear)"
          value={filters.searchQuery || ''}
          onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
          onKeyDown={handleKeyDown}
          className="w-full bg-ink border border-line rounded pl-9 pr-8 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
        />
        {filters.searchQuery && (
          <button
            type="button"
            aria-label="Clear search input"
            onClick={() => setFilters({ ...filters, searchQuery: '' })}
            className="absolute right-2 top-2 text-slate-400 hover:text-slate-200 p-0.5 rounded"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Department Dropdown */}
      <div>
        <label
          htmlFor="dept-select"
          className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1"
        >
          Department
        </label>
        <select
          id="dept-select"
          aria-label="Filter by department"
          value={filters.department || 'All Departments'}
          onChange={(e) => setFilters({ ...filters, department: e.target.value })}
          className="w-full bg-ink border border-line rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-command"
        >
          {distinctDepts.map((dept) => (
            <option key={dept} value={dept} className="bg-slate-900">
              {dept}
            </option>
          ))}
        </select>
      </div>

      {/* Toggles Grid: Connectivity & Health */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span
            id="status-toggle-label"
            className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1"
          >
            Status
          </span>
          <div
            role="group"
            aria-labelledby="status-toggle-label"
            className="flex rounded bg-ink p-0.5 border border-line"
          >
            {(['all', 'online', 'offline'] as const).map((status) => {
              const isActive = (filters.connectivity || 'all') === status;
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setFilters({ ...filters, connectivity: status })}
                  className={`flex-1 py-1 text-[10px] uppercase font-bold rounded transition capitalize focus:outline-none focus:ring-1 focus:ring-command ${
                    isActive
                      ? 'bg-command text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {status}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label
            htmlFor="health-select"
            className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1"
          >
            Health
          </label>
          <select
            id="health-select"
            aria-label="Filter by health status"
            value={filters.health || 'all'}
            onChange={(e) => setFilters({ ...filters, health: e.target.value as any })}
            className="w-full bg-ink border border-line rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-command capitalize"
          >
            <option value="all">All Health</option>
            <option value="operational">Operational</option>
            <option value="degraded">Degraded</option>
            <option value="fault">Fault</option>
          </select>
        </div>
      </div>

      {/* Reset Action */}
      <button
        type="button"
        onClick={handleReset}
        aria-label="Reset all active filters"
        className="flex items-center justify-center gap-1.5 w-full py-1 text-[11px] text-slate-400 hover:text-slate-200 hover:bg-panel-raised rounded transition focus:outline-none focus:ring-1 focus:ring-command"
      >
        <RotateCcw aria-hidden="true" className="h-3 w-3" />
        Reset Filters
      </button>
    </div>
  );
};

export default CameraFilterBar;