// frontend-map/app/admin/AreaManagementSection.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, Plus, Trash2, AlertTriangle, Pencil, Check, X, Info } from 'lucide-react';
import { areasService, Area } from '@/services/areasService';
import { locationsService, District, Taluka, Village } from '@/services/locationsService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';
import { SearchSelect } from '@/components/common/SearchSelect';

interface AreaManagementSectionProps {
  /** null for a super_admin (sees/manages every district); a specific
   * district string for a district_command (sees/manages only their own,
   * matching the backend's cross-district guard). */
  districtScope: string | null;
}

export function AreaManagementSection({ districtScope }: AreaManagementSectionProps) {
  const { cameras } = useCameraRegistry();
  const { has } = usePermissions();
  // Previously unguarded client-side -- Add/Rename/Delete relied entirely
  // on the backend's 403, with no disabled state or explanation shown.
  // Disabled-with-tooltip matches the same convention already used for
  // cameras (CameraContextMenu).
  const canManageAreas = has('manage_areas');
  const manageAreasTitle = canManageAreas ? undefined : 'Requires the Manage Areas permission';

  // District -> Taluka -> Village cascade. District/taluka lists are small
  // (34 / ~270 total, a few dozen at most per district) so they're fetched
  // in full and filtered client-side by SearchSelect; villages are
  // server-searched (19,000+ rows statewide) via locationsService.
  const [districts, setDistricts] = useState<District[]>([]);
  const [talukas, setTalukas] = useState<Taluka[]>([]);
  const [villages, setVillages] = useState<Village[]>([]);
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(null);
  const [selectedTaluka, setSelectedTaluka] = useState<Taluka | null>(null);
  const [selectedVillage, setSelectedVillage] = useState<Village | null>(null);
  const [villageSearchLoading, setVillageSearchLoading] = useState(false);

  const [areas, setAreas] = useState<Area[]>([]);
  const [areasLoading, setAreasLoading] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  // A district-scoped officer can't switch away from their own district --
  // same restriction the old per-card layout enforced by simply never
  // rendering another district's card.
  const isDistrictLocked = districtScope !== null;

  useEffect(() => {
    locationsService
      .listDistricts()
      .then((list) => {
        setDistricts(list);
        if (districtScope) {
          const match = list.find((d) => d.name === districtScope);
          if (match) setSelectedDistrict(match);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load districts'));
    // districtScope is fixed for the lifetime of this component (derived
    // from the logged-in officer's posting) -- only runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSelectedTaluka(null);
    setSelectedVillage(null);
    setTalukas([]);
    if (!selectedDistrict) return;
    locationsService
      .listTalukas(selectedDistrict.id)
      .then(setTalukas)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load talukas'));
  }, [selectedDistrict]);

  useEffect(() => {
    setSelectedVillage(null);
    setVillages([]);
    if (!selectedTaluka) return;
    setVillageSearchLoading(true);
    locationsService
      .searchVillages({ talukaId: selectedTaluka.id })
      .then(setVillages)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load villages'))
      .finally(() => setVillageSearchLoading(false));
  }, [selectedTaluka]);

  const handleVillageSearch = (term: string) => {
    if (!selectedTaluka) return;
    setVillageSearchLoading(true);
    locationsService
      .searchVillages({ talukaId: selectedTaluka.id, search: term || undefined })
      .then(setVillages)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to search villages'))
      .finally(() => setVillageSearchLoading(false));
  };

  const loadAreas = () => {
    if (!selectedVillage) return;
    setAreasLoading(true);
    setError(null);
    areasService
      .listAreas({ villageId: selectedVillage.id })
      .then(setAreas)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load areas'))
      .finally(() => setAreasLoading(false));
  };

  useEffect(() => {
    setAreas([]);
    if (selectedVillage) loadAreas();
    // loadAreas closes over selectedVillage -- re-running it here would be
    // circular; the dependency below is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVillage]);

  // Camera count per area -- drives the delete button's proactive disabled
  // state below. Derived from the already-fetched camera registry, so this
  // needs no new endpoint.
  const cameraCountByArea = useMemo(() => {
    const map = new Map<number, number>();
    for (const cam of cameras) {
      if (cam.area_id != null) map.set(cam.area_id, (map.get(cam.area_id) ?? 0) + 1);
    }
    return map;
  }, [cameras]);

  const handleAdd = async () => {
    const name = newAreaName.trim();
    if (!name || !selectedVillage) return;
    setError(null);
    try {
      await areasService.createArea({ name, village_id: selectedVillage.id });
      setNewAreaName('');
      loadAreas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create area');
    }
  };

  const handleDelete = async (area: Area) => {
    setError(null);
    try {
      await areasService.deleteArea(area.id);
      loadAreas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete area');
    }
  };

  const startEdit = (area: Area) => {
    setError(null);
    setEditingId(area.id);
    setEditName(area.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleRename = async (area: Area) => {
    const name = editName.trim();
    if (!name || name === area.name) {
      cancelEdit();
      return;
    }
    setError(null);
    try {
      await areasService.updateArea(area.id, { name });
      cancelEdit();
      loadAreas();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename area');
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <MapIcon size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Areas</h2>
          <p className="text-[11px] text-slate-500">
            District &rarr; Taluka &rarr; Village &rarr; Area. The location hierarchy is Government of India
            reference data (34 districts, ~270 talukas, ~19,000 villages) -- pick down to a village, then manage
            the areas (patrol points, landmarks) within it.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3 mt-4 mb-2 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{error}</p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
        <SearchSelect
          id="area-district-picker"
          label="District"
          items={districts}
          getKey={(d) => d.id}
          getLabel={(d) => d.name}
          value={selectedDistrict}
          onChange={setSelectedDistrict}
          placeholder="Search district..."
          disabled={isDistrictLocked}
        />
        <SearchSelect
          id="area-taluka-picker"
          label="Taluka"
          items={talukas}
          getKey={(t) => t.id}
          getLabel={(t) => t.name}
          value={selectedTaluka}
          onChange={setSelectedTaluka}
          placeholder={selectedDistrict ? 'Search taluka...' : 'Pick a district first'}
          disabled={!selectedDistrict}
          renderExtra={(t) => (t.no_lgd_data ? <Info size={11} className="text-signal-amber shrink-0" /> : null)}
        />
        <SearchSelect
          id="area-village-picker"
          label="Village / Town"
          items={villages}
          getKey={(v) => v.id}
          getLabel={(v) => v.name}
          value={selectedVillage}
          onChange={setSelectedVillage}
          placeholder={selectedTaluka ? 'Search village...' : 'Pick a taluka first'}
          disabled={!selectedTaluka}
          onSearchChange={selectedTaluka ? handleVillageSearch : undefined}
          emptyMessage={villageSearchLoading ? 'Searching...' : 'No villages match.'}
        />
      </div>

      {selectedTaluka?.no_lgd_data && (
        <div className="flex items-start gap-2.5 p-3 mt-3 max-w-2xl rounded-lg border border-signal-amber/30 bg-signal-amber/10 text-signal-amber">
          <Info size={14} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">
            {selectedTaluka.name} is a newer taluka split not yet covered by our village-level reference data --
            no villages are available to pick under it yet.
          </p>
        </div>
      )}

      {selectedVillage && (
        <div className="mt-5 border border-line rounded-lg bg-panel p-4 max-w-2xl">
          <h3 className="text-xs font-semibold text-white mb-2">
            Areas in {selectedVillage.name}
            <span className="text-slate-500 font-normal">
              {' '}
              &middot; {selectedTaluka?.name}, {selectedDistrict?.name}
            </span>
          </h3>
          {areasLoading ? (
            <p className="text-xs text-slate-500">Loading areas...</p>
          ) : (
            <ul className="space-y-1.5 mb-3">
              {areas.map((area) => {
                const count = cameraCountByArea.get(area.id) ?? 0;
                const deleteDisabled = count > 0;
                const isEditing = editingId === area.id;
                return (
                  <li key={area.id} className="flex items-center justify-between text-xs text-slate-300 gap-2">
                    {isEditing ? (
                      <>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          aria-label={`Rename ${area.name}`}
                          autoFocus
                          className="flex-1 bg-ink border border-line rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                        />
                        <button
                          type="button"
                          aria-label={`Save name for ${area.name}`}
                          onClick={() => handleRename(area)}
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
                        <span className="flex-1 truncate">{area.name}</span>
                        <button
                          type="button"
                          aria-label={`Edit ${area.name}`}
                          onClick={() => startEdit(area)}
                          disabled={!canManageAreas}
                          title={manageAreasTitle}
                          className={
                            canManageAreas
                              ? 'text-slate-500 hover:text-command'
                              : 'text-slate-700 cursor-not-allowed'
                          }
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${area.name}`}
                          onClick={() => handleDelete(area)}
                          disabled={!canManageAreas || deleteDisabled}
                          title={
                            !canManageAreas
                              ? manageAreasTitle
                              : deleteDisabled
                                ? `Cannot delete: ${count} camera${count === 1 ? '' : 's'} still assigned to this area`
                                : undefined
                          }
                          className={
                            !canManageAreas || deleteDisabled
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
              {areas.length === 0 && <li className="text-slate-600 italic text-xs">No areas yet in this village</li>}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              value={newAreaName}
              onChange={(e) => setNewAreaName(e.target.value)}
              placeholder="New area name"
              aria-label="Add area to selected village"
              disabled={!canManageAreas}
              title={manageAreasTitle}
              className="flex-1 bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!canManageAreas}
              title={manageAreasTitle}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-command"
            >
              <Plus size={12} />
              Add
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-600 mt-4 max-w-2xl">
        Bulk-add areas across many villages at once from Data Console (CSV/JSON import), or find an area from
        anywhere in Gujarat via the type-to-search Area field when adding a camera.
      </p>
    </section>
  );
}
