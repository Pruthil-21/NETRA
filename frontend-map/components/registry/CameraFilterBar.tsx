// components/registry/CameraFilterBar.tsx
'use client';

import React, { useMemo } from 'react';
import { useCameraRegistry } from '../../context/CameraRegistryContext';
import { Search, Filter, RotateCcw } from 'lucide-react';

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

  return (
    <div className="p-3 bg-slate-900 border-b border-slate-800 space-y-3">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search by ID, name, location..."
          value={filters.searchQuery || ''}
          onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
          className="w-full bg-slate-950 border border-slate-700 rounded pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
        />
      </div>

      {/* Department Dropdown */}
      <div>
        <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
          Department
        </label>
        <select
          value={filters.department || 'All Departments'}
          onChange={(e) => setFilters({ ...filters, department: e.target.value })}
          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
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
          <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
            Status
          </label>
          <div className="flex rounded bg-slate-950 p-0.5 border border-slate-800">
            {(['all', 'online', 'offline'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setFilters({ ...filters, connectivity: status })}
                className={`flex-1 py-1 text-[10px] uppercase font-bold rounded transition capitalize ${
                  (filters.connectivity || 'all') === status
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
            Health
          </label>
          <select
            value={filters.health || 'all'}
            onChange={(e) => setFilters({ ...filters, health: e.target.value as any })}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500 capitalize"
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
        className="flex items-center justify-center gap-1.5 w-full py-1 text-[11px] text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition"
      >
        <RotateCcw className="h-3 w-3" />
        Reset Filters
      </button>
    </div>
  );
};