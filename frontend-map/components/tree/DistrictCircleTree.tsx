'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, MapPin, Video, Landmark, Search, X } from 'lucide-react';
import { Circle } from '@/services/circlesService';
import { Camera } from '@/types/camera';

export type TreeSelection =
  | { type: 'district'; value: string }
  | { type: 'circle'; value: number }
  | { type: 'camera'; value: number }
  | null;

interface DistrictCircleTreeProps {
  districts: string[];
  circles: Circle[];
  cameras: Camera[];
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
}

/** Draws the ├──/└── connector for one row in a sibling list: a vertical
 * trunk down the row's left edge (full row height when a sibling follows,
 * half when this is the last one, so the trunk never dangles past the last
 * child) plus the short elbow tying it to the row's content. */
function TreeLines({ isLast }: { isLast: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={`absolute left-0 top-0 w-px bg-line ${isLast ? 'h-[14px]' : 'h-full'}`}
      />
      <span aria-hidden className="absolute left-0 top-[14px] w-3 h-px bg-line" />
    </>
  );
}

// This deployment only ever covers Gujarat -- a hardcoded single root rather
// than a real data-driven state level, since there's nothing to select
// between yet. Districts render as its children so the tree reads
// State -> District -> Area -> Camera, matching how officers actually
// describe the hierarchy on the ground.
const STATE_NAME = 'Gujarat';

/** VS Code Explorer-style tree: State -> District -> Area -> Camera, each
 * level (below the fixed state root) independently expandable. Shared,
 * byte-identical between the dashboard, map, and archive pages so their
 * navigation never drifts apart in behavior or styling. A camera-name
 * search narrows the whole tree at once: matching branches auto-expand,
 * everything else collapses out of the way -- an officer looking for one
 * camera by name shouldn't have to manually drill through every district. */
export function DistrictCircleTree({ districts, circles, cameras, selected, onSelect }: DistrictCircleTreeProps) {
  const [expandedDistricts, setExpandedDistricts] = useState<Set<string>>(new Set());
  const [expandedCircles, setExpandedCircles] = useState<Set<number>>(new Set());
  const [expandedUnassigned, setExpandedUnassigned] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');

  const toggleDistrict = (district: string) => {
    setExpandedDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(district)) next.delete(district);
      else next.add(district);
      return next;
    });
  };

  const toggleCircle = (circleId: number) => {
    setExpandedCircles((prev) => {
      const next = new Set(prev);
      if (next.has(circleId)) next.delete(circleId);
      else next.add(circleId);
      return next;
    });
  };

  const toggleUnassigned = (district: string) => {
    setExpandedUnassigned((prev) => {
      const next = new Set(prev);
      if (next.has(district)) next.delete(district);
      else next.add(district);
      return next;
    });
  };

  const circlesByDistrict = useMemo(() => {
    const map = new Map<string, Circle[]>();
    for (const circle of circles) {
      const list = map.get(circle.district) ?? [];
      list.push(circle);
      map.set(circle.district, list);
    }
    return map;
  }, [circles]);

  const camerasByCircle = useMemo(() => {
    const map = new Map<number, Camera[]>();
    for (const camera of cameras) {
      if (camera.circle_id == null) continue;
      const list = map.get(camera.circle_id) ?? [];
      list.push(camera);
      map.set(camera.circle_id, list);
    }
    return map;
  }, [cameras]);

  // Cameras registered against a district but never assigned to one of its
  // Areas yet -- without this, they'd be invisible in the tree entirely
  // (camerasByCircle only ever indexes cameras that DO have a circle_id),
  // which is exactly the "where did my camera go" gap this tree used to have.
  const unassignedCamerasByDistrict = useMemo(() => {
    const map = new Map<string, Camera[]>();
    for (const camera of cameras) {
      if (camera.circle_id != null) continue;
      const list = map.get(camera.dept) ?? [];
      list.push(camera);
      map.set(camera.dept, list);
    }
    return map;
  }, [cameras]);

  const isSearching = searchTerm.trim().length > 0;
  const term = searchTerm.trim().toLowerCase();
  const matchesTerm = (name: string) => name.toLowerCase().includes(term);

  return (
    <nav aria-label="Camera hierarchy" className="w-full h-full bg-panel overflow-y-auto text-xs flex flex-col">
      <div className="px-2 pt-2 pb-1 sticky top-0 bg-panel z-10 border-b border-line/60">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search cameras by name…"
            aria-label="Search cameras by name"
            className="w-full bg-ink border border-line rounded-md pl-6 pr-6 py-1.5 text-[11px] text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
          {searchTerm && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchTerm('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white p-0.5"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5 text-slate-200 font-semibold">
        <Landmark size={12} className="shrink-0" />
        <span className="truncate">{STATE_NAME}</span>
      </div>
      <div className="pl-4">
      {districts.map((district, di) => {
        const districtCirclesAll = circlesByDistrict.get(district) ?? [];
        const unassignedCamerasAll = unassignedCamerasByDistrict.get(district) ?? [];

        // With a search active, only keep circles/cameras that actually
        // contain a match, and force this branch open so the officer never
        // has to click through to see a result that's already found.
        const districtCircles = isSearching
          ? districtCirclesAll.filter(
              (c) => (camerasByCircle.get(c.id) ?? []).some((cam) => matchesTerm(cam.name)) || matchesTerm(c.name)
            )
          : districtCirclesAll;
        const unassignedCameras = isSearching
          ? unassignedCamerasAll.filter((cam) => matchesTerm(cam.name))
          : unassignedCamerasAll;

        if (isSearching && districtCircles.length === 0 && unassignedCameras.length === 0) return null;

        const isLastDistrict = di === districts.length - 1;
        const isDistrictExpanded = isSearching || expandedDistricts.has(district);
        const isDistrictSelected = selected?.type === 'district' && selected.value === district;
        const hasNoChildren = districtCircles.length === 0 && unassignedCameras.length === 0;
        return (
          <div key={district} className="relative pl-4">
            <TreeLines isLast={isLastDistrict} />
            <div
              className={`flex items-center gap-1 py-1.5 hover:bg-panel-raised ${
                isDistrictSelected ? 'bg-command/10 text-command' : 'text-slate-300'
              }`}
            >
              <button
                type="button"
                aria-label={isDistrictExpanded ? `Collapse ${district}` : `Expand ${district}`}
                onClick={() => toggleDistrict(district)}
                className="p-0.5 text-slate-500 hover:text-white shrink-0"
              >
                {isDistrictExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <button
                type="button"
                onClick={() => onSelect({ type: 'district', value: district })}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left truncate"
              >
                <Folder size={12} className="shrink-0" />
                <span className="truncate">{district}</span>
              </button>
            </div>
            {isDistrictExpanded && (
              <div className="pl-5">
                {hasNoChildren ? (
                  <p className="px-2 py-1.5 text-slate-600 italic">No areas yet</p>
                ) : (
                  <>
                  {districtCircles.map((circle, i) => {
                    const isLastCircle = i === districtCircles.length - 1 && unassignedCameras.length === 0;
                    const isCircleSelected = selected?.type === 'circle' && selected.value === circle.id;
                    const circleCamerasAll = camerasByCircle.get(circle.id) ?? [];
                    const circleCameras = isSearching
                      ? circleCamerasAll.filter((cam) => matchesTerm(cam.name))
                      : circleCamerasAll;
                    const isCircleExpanded = isSearching || expandedCircles.has(circle.id);
                    return (
                      <div key={circle.id} className="relative pl-4">
                        <TreeLines isLast={isLastCircle} />
                        <div
                          className={`flex items-center gap-1 py-1.5 hover:bg-panel-raised ${
                            isCircleSelected ? 'bg-command/10 text-command' : 'text-slate-400'
                          }`}
                        >
                          {circleCameras.length > 0 ? (
                            <button
                              type="button"
                              aria-label={isCircleExpanded ? `Collapse ${circle.name}` : `Expand ${circle.name}`}
                              onClick={() => toggleCircle(circle.id)}
                              className="p-0.5 text-slate-500 hover:text-white shrink-0"
                            >
                              {isCircleExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            </button>
                          ) : (
                            <span className="inline-block w-[15px] shrink-0" aria-hidden />
                          )}
                          <button
                            type="button"
                            onClick={() => onSelect({ type: 'circle', value: circle.id })}
                            className="flex items-center gap-1.5 flex-1 min-w-0 text-left truncate"
                          >
                            <MapPin size={11} className="shrink-0" />
                            <span className="truncate">{circle.name}</span>
                          </button>
                        </div>
                        {isCircleExpanded && circleCameras.length > 0 && (
                          <div className="pl-4">
                            {circleCameras.map((camera, j) => {
                              const isLastCamera = j === circleCameras.length - 1;
                              const isCameraSelected = selected?.type === 'camera' && selected.value === camera.id;
                              return (
                                <div key={camera.id} className="relative pl-4">
                                  <TreeLines isLast={isLastCamera} />
                                  <button
                                    type="button"
                                    onClick={() => onSelect({ type: 'camera', value: camera.id })}
                                    className={`flex items-center gap-1.5 w-full py-1.5 text-left truncate hover:bg-panel-raised ${
                                      isCameraSelected ? 'bg-command/10 text-command' : 'text-slate-500'
                                    }`}
                                  >
                                    <Video size={10} className="shrink-0" />
                                    <span className="truncate">{camera.name}</span>
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {unassignedCameras.length > 0 && (() => {
                    const isUnassignedExpanded = isSearching || expandedUnassigned.has(district);
                    return (
                      <div className="relative pl-4">
                        <TreeLines isLast />
                        <div className="flex items-center gap-1 py-1.5 hover:bg-panel-raised text-slate-400">
                          <button
                            type="button"
                            aria-label={isUnassignedExpanded ? `Collapse unassigned cameras in ${district}` : `Expand unassigned cameras in ${district}`}
                            onClick={() => toggleUnassigned(district)}
                            className="p-0.5 text-slate-500 hover:text-white shrink-0"
                          >
                            {isUnassignedExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          </button>
                          <span className="flex items-center gap-1.5 flex-1 min-w-0 text-left truncate italic text-slate-500">
                            <MapPin size={11} className="shrink-0" />
                            <span className="truncate">Unassigned ({unassignedCameras.length})</span>
                          </span>
                        </div>
                        {isUnassignedExpanded && (
                          <div className="pl-4">
                            {unassignedCameras.map((camera, j) => {
                              const isLastCamera = j === unassignedCameras.length - 1;
                              const isCameraSelected = selected?.type === 'camera' && selected.value === camera.id;
                              return (
                                <div key={camera.id} className="relative pl-4">
                                  <TreeLines isLast={isLastCamera} />
                                  <button
                                    type="button"
                                    onClick={() => onSelect({ type: 'camera', value: camera.id })}
                                    className={`flex items-center gap-1.5 w-full py-1.5 text-left truncate hover:bg-panel-raised ${
                                      isCameraSelected ? 'bg-command/10 text-command' : 'text-slate-500'
                                    }`}
                                  >
                                    <Video size={10} className="shrink-0" />
                                    <span className="truncate">{camera.name}</span>
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {isSearching && districts.every((district) => {
        const districtCirclesAll = circlesByDistrict.get(district) ?? [];
        const unassignedCamerasAll = unassignedCamerasByDistrict.get(district) ?? [];
        const hasMatch =
          districtCirclesAll.some((c) => (camerasByCircle.get(c.id) ?? []).some((cam) => matchesTerm(cam.name)) || matchesTerm(c.name)) ||
          unassignedCamerasAll.some((cam) => matchesTerm(cam.name));
        return !hasMatch;
      }) && (
        <p className="px-2 py-4 text-slate-600 italic text-center">No cameras match &quot;{searchTerm}&quot;</p>
      )}
      </div>
    </nav>
  );
}

export default DistrictCircleTree;
