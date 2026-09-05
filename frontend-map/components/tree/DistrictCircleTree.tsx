'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, MapPin, Video, Landmark } from 'lucide-react';
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
 * byte-identical between the dashboard and map pages so their navigation
 * never drifts apart in behavior or styling. */
export function DistrictCircleTree({ districts, circles, cameras, selected, onSelect }: DistrictCircleTreeProps) {
  const [expandedDistricts, setExpandedDistricts] = useState<Set<string>>(new Set());
  const [expandedCircles, setExpandedCircles] = useState<Set<number>>(new Set());

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

  return (
    <nav aria-label="Camera hierarchy" className="w-full h-full bg-panel overflow-y-auto text-xs">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-slate-200 font-semibold">
        <Landmark size={12} className="shrink-0" />
        <span className="truncate">{STATE_NAME}</span>
      </div>
      <div className="pl-4">
      {districts.map((district, di) => {
        const isLastDistrict = di === districts.length - 1;
        const isDistrictExpanded = expandedDistricts.has(district);
        const isDistrictSelected = selected?.type === 'district' && selected.value === district;
        const districtCircles = circlesByDistrict.get(district) ?? [];
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
                {districtCircles.length === 0 ? (
                  <p className="px-2 py-1.5 text-slate-600 italic">No areas yet</p>
                ) : (
                  districtCircles.map((circle, i) => {
                    const isLastCircle = i === districtCircles.length - 1;
                    const isCircleSelected = selected?.type === 'circle' && selected.value === circle.id;
                    const isCircleExpanded = expandedCircles.has(circle.id);
                    const circleCameras = camerasByCircle.get(circle.id) ?? [];
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
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </nav>
  );
}

export default DistrictCircleTree;
