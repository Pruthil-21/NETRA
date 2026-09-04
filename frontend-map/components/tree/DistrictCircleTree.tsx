'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, MapPin } from 'lucide-react';
import { Circle } from '@/services/circlesService';

export type TreeSelection =
  | { type: 'district'; value: string }
  | { type: 'circle'; value: number }
  | null;

interface DistrictCircleTreeProps {
  districts: string[];
  circles: Circle[];
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
}

/** VS Code Explorer-style tree: District nodes expand to Circle nodes, no
 * camera-level leaves. Shared, byte-identical between the dashboard and map
 * pages so their navigation never drifts apart in behavior or styling. */
export function DistrictCircleTree({ districts, circles, selected, onSelect }: DistrictCircleTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (district: string) => {
    setExpanded((prev) => {
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

  return (
    <nav aria-label="Camera hierarchy" className="w-56 shrink-0 border-r border-line bg-panel overflow-y-auto text-xs">
      {districts.map((district) => {
        const isExpanded = expanded.has(district);
        const isDistrictSelected = selected?.type === 'district' && selected.value === district;
        const districtCircles = circlesByDistrict.get(district) ?? [];
        return (
          <div key={district}>
            <div
              className={`flex items-center gap-1 px-2 py-1.5 hover:bg-panel-raised ${
                isDistrictSelected ? 'bg-command/10 text-command' : 'text-slate-300'
              }`}
            >
              <button
                type="button"
                aria-label={isExpanded ? `Collapse ${district}` : `Expand ${district}`}
                onClick={() => toggleExpanded(district)}
                className="p-0.5 text-slate-500 hover:text-white shrink-0"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
            {isExpanded && (
              <div className="pl-6">
                {districtCircles.length === 0 ? (
                  <p className="px-2 py-1.5 text-slate-600 italic">No circles yet</p>
                ) : (
                  districtCircles.map((circle) => {
                    const isCircleSelected = selected?.type === 'circle' && selected.value === circle.id;
                    return (
                      <button
                        key={circle.id}
                        type="button"
                        onClick={() => onSelect({ type: 'circle', value: circle.id })}
                        className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-left truncate hover:bg-panel-raised ${
                          isCircleSelected ? 'bg-command/10 text-command' : 'text-slate-400'
                        }`}
                      >
                        <MapPin size={11} className="shrink-0" />
                        <span className="truncate">{circle.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default DistrictCircleTree;
