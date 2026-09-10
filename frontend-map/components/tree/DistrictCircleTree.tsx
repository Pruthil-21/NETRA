'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, MapPin, Video, Landmark, Search, X } from 'lucide-react';
import { Circle } from '@/services/circlesService';
import { Camera } from '@/types/camera';
import { startCameraDrag } from '@/lib/cameraDrag';

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
  /** The signed-in officer's own posting district (e.g. "Ahmedabad"), if
   * any -- when set, that district is pulled to the top of the list so an
   * officer posted to it isn't scrolling past every other district in the
   * state to find their own turf. Purely a display reorder; it doesn't
   * affect which districts are visible or how access is scoped. */
  homeDistrict?: string | null;
  /** When true, every district starts collapsed instead of expanded --
   * for views where the full tree at once is more clutter than an officer
   * wants on first load. Off by default so existing callers are unaffected. */
  defaultCollapsed?: boolean;
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
export function DistrictCircleTree({
  districts,
  circles,
  cameras,
  selected,
  onSelect,
  homeDistrict,
  defaultCollapsed = false,
}: DistrictCircleTreeProps) {
  // Expanded by default, every load -- deterministic from the current data,
  // not from any browser cache/storage, so it's identical in a brand-new
  // incognito window, a reload, or a fresh tab. Tracking what's COLLAPSED
  // (rather than what's expanded) is what makes "expanded" the default:
  // an empty set here means nothing has been collapsed, so everything shows.
  const [collapsedDistricts, setCollapsedDistricts] = useState<Set<string>>(new Set());
  const [collapsedCircles, setCollapsedCircles] = useState<Set<number>>(new Set());
  const [collapsedUnassigned, setCollapsedUnassigned] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  // Per-district local search -- a small search icon on each district row
  // opens a scoped search box under it, for "find a camera in Ahmedabad
  // specifically" without the universal search bar's whole-tree results.
  // Presence of a district's key here (even an empty string) means its box
  // is open; absence means closed. Unlike the universal search (name only,
  // left untouched), local search also matches by camera id, since that's
  // what an officer scoped to one district is more likely to already know.
  const [districtSearch, setDistrictSearch] = useState<Record<string, string>>({});

  // districts/circles each arrive empty on first render (separate async
  // fetches -- camera feeds vs. circlesService.listCircles()) and fill in
  // moments later, not necessarily at the same time -- each level seeds
  // "start collapsed" independently, once, the first time there's actually
  // something at that level to collapse. Seeding both from a single "did
  // districts arrive" check would leave circles expanded whenever they load
  // after that check already ran (the original bug this fixes: districts
  // collapsed, but every district's areas and cameras still shown open the
  // moment it's expanded).
  const seededDistrictCollapse = useRef(false);
  useEffect(() => {
    if (defaultCollapsed && !seededDistrictCollapse.current && districts.length > 0) {
      setCollapsedDistricts(new Set(districts));
      setCollapsedUnassigned(new Set(districts));
      seededDistrictCollapse.current = true;
    }
  }, [defaultCollapsed, districts]);

  const seededCircleCollapse = useRef(false);
  useEffect(() => {
    if (defaultCollapsed && !seededCircleCollapse.current && circles.length > 0) {
      setCollapsedCircles(new Set(circles.map((c) => c.id)));
      seededCircleCollapse.current = true;
    }
  }, [defaultCollapsed, circles]);

  // Pulls the officer's own posting district to the top of the list --
  // everything else keeps its existing (alphabetical) order behind it.
  const orderedDistricts = useMemo(() => {
    if (!homeDistrict) return districts;
    const home = districts.filter((d) => d.toLowerCase() === homeDistrict.toLowerCase());
    const rest = districts.filter((d) => d.toLowerCase() !== homeDistrict.toLowerCase());
    return [...home, ...rest];
  }, [districts, homeDistrict]);

  const toggleDistrict = (district: string) => {
    setCollapsedDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(district)) next.delete(district);
      else next.add(district);
      return next;
    });
  };

  const toggleCircle = (circleId: number) => {
    setCollapsedCircles((prev) => {
      const next = new Set(prev);
      if (next.has(circleId)) next.delete(circleId);
      else next.add(circleId);
      return next;
    });
  };

  const toggleUnassigned = (district: string) => {
    setCollapsedUnassigned((prev) => {
      const next = new Set(prev);
      if (next.has(district)) next.delete(district);
      else next.add(district);
      return next;
    });
  };

  const toggleDistrictSearch = (district: string) => {
    setDistrictSearch((prev) => {
      const next = { ...prev };
      if (district in next) delete next[district];
      else next[district] = '';
      return next;
    });
  };

  // Closing on outside-click/Escape only while at least one box is open --
  // a primitive (not the districtSearch object itself) in the dependency
  // array so this doesn't tear down and re-attach the listeners on every
  // keystroke, only when a box actually opens or every box closes. Every
  // search-icon button and open search box carries data-district-search,
  // so a click landing on either is "inside" and left alone; anything else
  // (the rest of the tree, the page outside it) closes every open box.
  const hasOpenDistrictSearch = Object.keys(districtSearch).length > 0;
  useEffect(() => {
    if (!hasOpenDistrictSearch) return;
    const closeAll = () => setDistrictSearch({});
    const handlePointerDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-district-search]')) closeAll();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hasOpenDistrictSearch]);

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
  const textMatches = (value: string, t: string) => value.toLowerCase().includes(t);
  const cameraMatchesLocal = (cam: Camera, t: string) => textMatches(cam.name, t) || String(cam.id).includes(t);

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
      {orderedDistricts.map((district, di) => {
        const districtCirclesAll = circlesByDistrict.get(district) ?? [];
        const unassignedCamerasAll = unassignedCamerasByDistrict.get(district) ?? [];

        const districtLocalTerm = (districtSearch[district] ?? '').trim().toLowerCase();
        const isDistrictLocalOpen = district in districtSearch;
        const isLocalSearching = districtLocalTerm.length > 0;

        // With a search active (global or this district's own local box),
        // only keep circles/cameras that actually contain a match, and
        // force this branch open so the officer never has to click through
        // to see a result that's already found. The two searches stay
        // independent -- local search matching by camera id too (the
        // universal bar deliberately doesn't, left as-is) never changes
        // what the universal bar alone would have shown.
        const districtCircles = (isSearching || isLocalSearching)
          ? districtCirclesAll.filter((c) => {
              const camsHere = camerasByCircle.get(c.id) ?? [];
              const matchesGlobal = isSearching && (camsHere.some((cam) => matchesTerm(cam.name)) || matchesTerm(c.name));
              const matchesLocal =
                isLocalSearching &&
                (camsHere.some((cam) => cameraMatchesLocal(cam, districtLocalTerm)) ||
                  textMatches(c.name, districtLocalTerm));
              return matchesGlobal || matchesLocal;
            })
          : districtCirclesAll;
        const unassignedCameras = (isSearching || isLocalSearching)
          ? unassignedCamerasAll.filter(
              (cam) =>
                (isSearching && matchesTerm(cam.name)) || (isLocalSearching && cameraMatchesLocal(cam, districtLocalTerm))
            )
          : unassignedCamerasAll;

        // Only the universal bar hides a whole district on zero matches --
        // a local search with zero results still needs the district (and
        // its now-open search box) to stay visible, or there'd be no way
        // to see the box was even open.
        if (isSearching && !isLocalSearching && districtCircles.length === 0 && unassignedCameras.length === 0) {
          return null;
        }

        const isLastDistrict = di === orderedDistricts.length - 1;
        const isDistrictExpanded = isSearching || isLocalSearching || !collapsedDistricts.has(district);
        const isDistrictSelected = selected?.type === 'district' && selected.value === district;
        const hasNoChildren = districtCircles.length === 0 && unassignedCameras.length === 0;
        // Every camera in this district, assigned to an area or not -- what
        // a drag of the whole district row hands the drop target (Dashboard/
        // Archive grid). Uses the unfiltered *All lists, not the possibly
        // search-narrowed ones: dragging "this district" means every camera
        // in it, regardless of an unrelated search term.
        const districtCameraIds = [
          ...districtCirclesAll.flatMap((c) => (camerasByCircle.get(c.id) ?? []).map((cam) => cam.id)),
          ...unassignedCamerasAll.map((cam) => cam.id),
        ];
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
                draggable={districtCameraIds.length > 0}
                onDragStart={startCameraDrag(districtCameraIds)}
                title={districtCameraIds.length > 0 ? `Drag to watch all ${districtCameraIds.length} camera(s) in ${district}` : undefined}
                onClick={() => {
                  onSelect({ type: 'district', value: district });
                  if (!hasNoChildren) toggleDistrict(district);
                }}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left truncate cursor-grab active:cursor-grabbing"
              >
                <Folder size={12} className="shrink-0" />
                <span className="truncate">{district}</span>
              </button>
              <button
                type="button"
                data-district-search
                onClick={() => toggleDistrictSearch(district)}
                aria-label={isDistrictLocalOpen ? `Close search in ${district}` : `Search cameras in ${district}`}
                title={`Search cameras in ${district} by name, ID, or area`}
                className={`p-1 rounded shrink-0 ${
                  isDistrictLocalOpen ? 'text-command bg-command/10' : 'text-slate-500 hover:text-white'
                }`}
              >
                <Search size={11} />
              </button>
            </div>
            {isDistrictLocalOpen && (
              <div className="pl-5 pr-1.5 pb-1.5" data-district-search>
                <div className="relative">
                  <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    type="text"
                    autoFocus
                    value={districtSearch[district] ?? ''}
                    onChange={(e) => setDistrictSearch((prev) => ({ ...prev, [district]: e.target.value }))}
                    placeholder={`Search in ${district}…`}
                    aria-label={`Search cameras in ${district}`}
                    className="w-full bg-ink border border-line rounded pl-6 pr-6 py-1 text-[10px] text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                  />
                  {districtSearch[district] && (
                    <button
                      type="button"
                      aria-label={`Clear search in ${district}`}
                      onClick={() => setDistrictSearch((prev) => ({ ...prev, [district]: '' }))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white p-0.5"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              </div>
            )}
            {isDistrictExpanded && (
              <div className="pl-5">
                {hasNoChildren ? (
                  <p className="px-2 py-1.5 text-slate-600 italic">
                    {isLocalSearching ? `No cameras match "${districtSearch[district]}"` : 'No areas yet'}
                  </p>
                ) : (
                  <>
                  {districtCircles.map((circle, i) => {
                    const isLastCircle = i === districtCircles.length - 1 && unassignedCameras.length === 0;
                    const isCircleSelected = selected?.type === 'circle' && selected.value === circle.id;
                    const circleCamerasAll = camerasByCircle.get(circle.id) ?? [];
                    const circleCameras = (isSearching || isLocalSearching)
                      ? circleCamerasAll.filter(
                          (cam) =>
                            (isSearching && matchesTerm(cam.name)) ||
                            (isLocalSearching && cameraMatchesLocal(cam, districtLocalTerm))
                        )
                      : circleCamerasAll;
                    const isCircleExpanded = isSearching || isLocalSearching || !collapsedCircles.has(circle.id);
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
                            draggable={circleCamerasAll.length > 0}
                            onDragStart={startCameraDrag(circleCamerasAll.map((cam) => cam.id))}
                            title={circleCamerasAll.length > 0 ? `Drag to watch all ${circleCamerasAll.length} camera(s) in ${circle.name}` : undefined}
                            onClick={() => {
                              onSelect({ type: 'circle', value: circle.id });
                              if (circleCameras.length > 0) toggleCircle(circle.id);
                            }}
                            className="flex items-center gap-1.5 flex-1 min-w-0 text-left truncate cursor-grab active:cursor-grabbing"
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
                                    draggable
                                    onDragStart={startCameraDrag([camera.id])}
                                    title={`Drag to watch ${camera.name}`}
                                    onClick={() => onSelect({ type: 'camera', value: camera.id })}
                                    className={`flex items-center gap-1.5 w-full py-1.5 text-left truncate hover:bg-panel-raised cursor-grab active:cursor-grabbing ${
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
                    const isUnassignedExpanded = isSearching || isLocalSearching || !collapsedUnassigned.has(district);
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
                                    draggable
                                    onDragStart={startCameraDrag([camera.id])}
                                    title={`Drag to watch ${camera.name}`}
                                    onClick={() => onSelect({ type: 'camera', value: camera.id })}
                                    className={`flex items-center gap-1.5 w-full py-1.5 text-left truncate hover:bg-panel-raised cursor-grab active:cursor-grabbing ${
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
