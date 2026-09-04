// frontend-map/app/admin/CircleManagementSection.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { circlesService, Circle } from '@/services/circlesService';

interface CircleManagementSectionProps {
  /** null for a super_admin (sees/manages every district); a specific
   * district string for a district_command (sees/manages only their own,
   * matching the backend's cross-district guard). */
  districtScope: string | null;
}

export function CircleManagementSection({ districtScope }: CircleManagementSectionProps) {
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCircleName, setNewCircleName] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    circlesService
      .listCircles()
      .then(setCircles)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const districts = districtScope ? [districtScope] : Array.from(new Set(circles.map((c) => c.district))).sort();
  const circlesByDistrict = useMemo(() => {
    const map = new Map<string, Circle[]>();
    for (const circle of circles) {
      const list = map.get(circle.district) ?? [];
      list.push(circle);
      map.set(circle.district, list);
    }
    return map;
  }, [circles]);

  const handleAdd = async (district: string) => {
    const name = (newCircleName[district] ?? '').trim();
    if (!name) return;
    setError(null);
    try {
      await circlesService.createCircle({ name, district });
      setNewCircleName((prev) => ({ ...prev, [district]: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create circle');
    }
  };

  const handleDelete = async (circle: Circle) => {
    setError(null);
    try {
      await circlesService.deleteCircle(circle.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete circle');
    }
  };

  if (loading) return <p className="text-xs text-slate-500">Loading circles...</p>;

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <MapIcon size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Circles</h2>
          <p className="text-[11px] text-slate-500">Manage the District→Circle grouping cameras are organized under</p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3 mt-4 mb-2 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{error}</p>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4 max-w-2xl">
        {districts.map((district) => (
          <div key={district} className="border border-line rounded-lg bg-panel p-4">
            <h3 className="text-xs font-semibold text-white mb-2">{district}</h3>
            <ul className="space-y-1.5 mb-3">
              {(circlesByDistrict.get(district) ?? []).map((circle) => (
                <li key={circle.id} className="flex items-center justify-between text-xs text-slate-300">
                  <span>{circle.name}</span>
                  <button
                    type="button"
                    aria-label={`Delete ${circle.name}`}
                    onClick={() => handleDelete(circle)}
                    className="text-slate-500 hover:text-signal-red"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
              {(circlesByDistrict.get(district) ?? []).length === 0 && (
                <li className="text-slate-600 italic text-xs">No circles yet</li>
              )}
            </ul>
            <div className="flex gap-2">
              <input
                value={newCircleName[district] ?? ''}
                onChange={(e) => setNewCircleName((prev) => ({ ...prev, [district]: e.target.value }))}
                placeholder="New circle name"
                aria-label={`Add circle to ${district}`}
                className="flex-1 bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
              />
              <button
                type="button"
                onClick={() => handleAdd(district)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded"
              >
                <Plus size={12} />
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
