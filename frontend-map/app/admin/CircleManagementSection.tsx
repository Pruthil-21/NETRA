// frontend-map/app/admin/CircleManagementSection.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, Plus, Trash2, AlertTriangle, Pencil, Check, X } from 'lucide-react';
import { circlesService, Circle } from '@/services/circlesService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';

interface CircleManagementSectionProps {
  /** null for a super_admin (sees/manages every district); a specific
   * district string for a district_command (sees/manages only their own,
   * matching the backend's cross-district guard). */
  districtScope: string | null;
}

export function CircleManagementSection({ districtScope }: CircleManagementSectionProps) {
  const { cameras } = useCameraRegistry();
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCircleName, setNewCircleName] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    circlesService
      .listCircles()
      .then(setCircles)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load areas'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Districts come from the camera registry's known depts, not just from
  // whichever districts already have a circle -- a district with zero
  // circles still needs a row here so a super_admin can create its first
  // one. Unioned with any district a circle already exists in (a circle
  // could technically outlive every one of its district's cameras).
  const districts = districtScope
    ? [districtScope]
    : Array.from(new Set([...cameras.map((c) => c.dept), ...circles.map((c) => c.district)])).sort();

  const circlesByDistrict = useMemo(() => {
    const map = new Map<string, Circle[]>();
    for (const circle of circles) {
      const list = map.get(circle.district) ?? [];
      list.push(circle);
      map.set(circle.district, list);
    }
    return map;
  }, [circles]);

  // Camera count per circle -- drives the delete button's proactive
  // disabled state below. Derived from the same camera registry already
  // fetched for the district list above, so this needs no new endpoint.
  const cameraCountByCircle = useMemo(() => {
    const map = new Map<number, number>();
    for (const cam of cameras) {
      if (cam.circle_id != null) map.set(cam.circle_id, (map.get(cam.circle_id) ?? 0) + 1);
    }
    return map;
  }, [cameras]);

  const handleAdd = async (district: string) => {
    const name = (newCircleName[district] ?? '').trim();
    if (!name) return;
    setError(null);
    try {
      await circlesService.createCircle({ name, district });
      setNewCircleName((prev) => ({ ...prev, [district]: '' }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create area');
    }
  };

  const handleDelete = async (circle: Circle) => {
    setError(null);
    try {
      await circlesService.deleteCircle(circle.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete area');
    }
  };

  const startEdit = (circle: Circle) => {
    setError(null);
    setEditingId(circle.id);
    setEditName(circle.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleRename = async (circle: Circle) => {
    const name = editName.trim();
    if (!name || name === circle.name) {
      cancelEdit();
      return;
    }
    setError(null);
    try {
      await circlesService.updateCircle(circle.id, { name });
      cancelEdit();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename area');
    }
  };

  if (loading) return <p className="text-xs text-slate-500">Loading areas...</p>;

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <MapIcon size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Areas</h2>
          <p className="text-[11px] text-slate-500">Manage the District→Area grouping cameras are organized under</p>
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
              {(circlesByDistrict.get(district) ?? []).map((circle) => {
                const count = cameraCountByCircle.get(circle.id) ?? 0;
                const deleteDisabled = count > 0;
                const isEditing = editingId === circle.id;
                return (
                  <li key={circle.id} className="flex items-center justify-between text-xs text-slate-300 gap-2">
                    {isEditing ? (
                      <>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          aria-label={`Rename ${circle.name}`}
                          autoFocus
                          className="flex-1 bg-ink border border-line rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                        />
                        <button
                          type="button"
                          aria-label={`Save name for ${circle.name}`}
                          onClick={() => handleRename(circle)}
                          className="text-signal-green hover:text-signal-green/80"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel rename"
                          onClick={cancelEdit}
                          className="text-slate-500 hover:text-white"
                        >
                          <X size={13} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate">{circle.name}</span>
                        <button
                          type="button"
                          aria-label={`Edit ${circle.name}`}
                          onClick={() => startEdit(circle)}
                          className="text-slate-500 hover:text-command"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${circle.name}`}
                          onClick={() => handleDelete(circle)}
                          disabled={deleteDisabled}
                          title={
                            deleteDisabled
                              ? `Cannot delete: ${count} camera${count === 1 ? '' : 's'} still assigned to this area`
                              : undefined
                          }
                          className={
                            deleteDisabled
                              ? 'text-slate-700 cursor-not-allowed'
                              : 'text-slate-500 hover:text-signal-red'
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
              {(circlesByDistrict.get(district) ?? []).length === 0 && (
                <li className="text-slate-600 italic text-xs">No areas yet</li>
              )}
            </ul>
            <div className="flex gap-2">
              <input
                value={newCircleName[district] ?? ''}
                onChange={(e) => setNewCircleName((prev) => ({ ...prev, [district]: e.target.value }))}
                placeholder="New area name"
                aria-label={`Add area to ${district}`}
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
