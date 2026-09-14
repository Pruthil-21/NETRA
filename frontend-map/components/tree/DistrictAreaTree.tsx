'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Building2, MapPin, Video, Landmark, Search, X, MoreVertical } from 'lucide-react';
import { Area } from '@/services/areasService';
import { Camera } from '@/types/camera';
import { startCameraDrag } from '@/lib/cameraDrag';
import { usePermissions } from '@/hooks/usePermissions';
import { isInScope } from '@/lib/scope';
import { CameraContextMenu } from '@/components/registry/CameraContextMenu';
import CameraDetailModal from '@/components/registry/CameraDetailModal';
import ConfigureCameraModal from '@/components/registry/ConfigureCameraModal';

export type TreeSelection =
  | { type: 'district'; value: string }
  | { type: 'area'; value: number }
  | { type: 'camera'; value: number }
  | null;

interface DistrictAreaTreeProps {
  districts: string[];
  areas: Area[];
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
  /** Drag-to-watch (grab a district/area/camera row onto a watch grid) only
   * does anything where a drop target actually exists -- Dashboard and
   * Archive. The Map page has none, so leaving rows draggable there was a
   * plain cursor/UX bug: a grab cursor promising an interaction that's a
   * no-op. Defaults to true so those two existing callers are unaffected;
   * Map passes false. */
  enableDrag?: boolean;
  /** Backs the right-click menu's "Play" item -- only Dashboard supplies
   * this (it owns the watch-set grid); Map and Archive omit it, so that
   * item simply doesn't render there. Reuses the exact same "add to the
   * watch set" path a drag already triggers, just from a menu click
   * instead of a drop event. */
  onPlayCamera?: (cameraId: number) => void;
}

/** One step up the State -> District -> Area -> Camera hierarchy from the
 * given selection -- camera to its area (or straight to its district if
 * it's unassigned), area to its district, district to "everything" (null).
 * Pure and RBAC-free by design: it only ever resolves to a value already
 * reachable through `cameras`/`areas`, which the caller has already scoped
 * to the signed-in officer's jurisdiction (see effective_district_scopes on
 * the backend) -- there's no broader place for it to step up TO than what
 * was already visible in the tree. Returns null (unchanged) if the
 * selection's own camera/area can't be found, rather than guessing. */
export function getParentSelection(
  selection: TreeSelection,
  cameras: Camera[],
  areas: Area[]
): TreeSelection {
  if (selection === null) return null;
  if (selection.type === 'camera') {
    const camera = cameras.find((c) => c.id === selection.value);
    if (!camera) return null;
    return camera.area_id != null
      ? { type: 'area', value: camera.area_id }
      : { type: 'district', value: camera.dept };
  }
  if (selection.type === 'area') {
    const area = areas.find((a) => a.id === selection.value);
    return area ? { type: 'district', value: area.district } : null;
  }
  return null;
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
export function DistrictAreaTree({
  districts,
  areas,
  cameras,
  selected,
  onSelect,
  homeDistrict,
  defaultCollapsed = false,
  enableDrag = true,
  onPlayCamera,
}: DistrictAreaTreeProps) {
  const { has, scopeType, scopeValue } = usePermissions();
  const canManageCameras = has('manage_cameras');
  // Which camera's right-click/⋮ menu (if any) is open, and where -- anchor
  // is the click point for a real right-click, or the "⋮" button's own
  // bounding rect for the hover-trigger alternative (needed for touch/no
  // right-click devices). Properties/Configure open their own modals on top
  // of (and independent from) this menu.
  const [menuState, setMenuState] = useState<{ camera: Camera; anchor: { x: number; y: number } } | null>(null);
  const [detailCamera, setDetailCamera] = useState<Camera | null>(null);
  const [configureCamera, setConfigureCamera] = useState<Camera | null>(null);

  const openMenu = (camera: Camera, anchor: { x: number; y: number }) => setMenuState({ camera, anchor });
  // Expanded by default, every load -- deterministic from the current data,
  // not from any browser cache/storage, so it's identical in a brand-new
  // incognito window, a reload, or a fresh tab. Tracking what's COLLAPSED
  // (rather than what's expanded) is what makes "expanded" the default:
  // an empty set here means nothing has been collapsed, so everything shows.
  const [collapsedDistricts, setCollapsedDistricts] = useState<Set<string>>(new Set());
  const [collapsedAreas, setCollapsedAreas] = useState<Set<number>>(new Set());
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

  // districts/areas each arrive empty on first render (separate async
  // fetches -- camera feeds vs. areasService.listAreas()) and fill in
  // moments later, not necessarily at the same time -- each level seeds
  // "start collapsed" independently, once, the first time there's actually
  // something at that level to collapse. Seeding both from a single "did
  // districts arrive" check would leave areas expanded whenever they load
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

  const seededAreaCollapse = useRef(false);
  useEffect(() => {
    if (defaultCollapsed && !seededAreaCollapse.current && areas.length > 0) {
      setCollapsedAreas(new Set(areas.map((c) => c.id)));
      seededAreaCollapse.current = true;
    }
  }, [defaultCollapsed, areas]);

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

  const toggleArea = (areaId: number) => {
    setCollapsedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
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

  // Escape steps the current selection up one level of the hierarchy
  // instead of doing nothing -- camera -> its area -> its district ->
  // everything. Skipped while a local district search box is open (the
  // handler above owns Escape then: closing that box takes priority over
  // navigating the tree behind it) and once selection is already null
  // (nothing left to step up to). A ref, not `selected` itself, in the
  // effect body avoids tearing this listener down and re-attaching it on
  // every selection change -- it only needs to run once per mount and read
  // whatever the latest selection/cameras/areas are when Escape actually
  // fires.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    if (hasOpenDistrictSearch) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectedRef.current === null) return;
      onSelect(getParentSelection(selectedRef.current, cameras, areas));
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hasOpenDistrictSearch, onSelect, cameras, areas]);

  const areasByDistrict = useMemo(() => {
    const map = new Map<string, Area[]>();
    for (const area of areas) {
      const list = map.get(area.district) ?? [];
      list.push(area);
      map.set(area.district, list);
    }
    return map;
  }, [areas]);

  const camerasByArea = useMemo(() => {
    const map = new Map<number, Camera[]>();
    for (const camera of cameras) {
      if (camera.area_id == null) continue;
      const list = map.get(camera.area_id) ?? [];
      list.push(camera);
      map.set(camera.area_id, list);
    }
    return map;
  }, [cameras]);

  // Cameras registered against a district but never assigned to one of its
  // Areas yet -- without this, they'd be invisible in the tree entirely
  // (camerasByArea only ever indexes cameras that DO have a area_id),
  // which is exactly the "where did my camera go" gap this tree used to have.
  const unassignedCamerasByDistrict = useMemo(() => {
    const map = new Map<string, Camera[]>();
    for (const camera of cameras) {
      if (camera.area_id != null) continue;
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

  // Shared by both places a camera leaf renders (under its area, and under
  // an "Unassigned" bucket) -- identical row markup either way, just a
  // different source list, so this is the one place a change to the row
  // itself (the ⋮ trigger below, e.g.) has to be made.
  const renderCameraRow = (camera: Camera, isLast: boolean) => {
    const isCameraSelected = selected?.type === 'camera' && selected.value === camera.id;
    // connectivity_status is decided server-side now (backend-registry's own
    // periodic sweep), so this reflects the real, current state -- not a
    // guess. Online is filled (fill=currentColor) as well as colored so it
    // reads as "solid/confirmed" at a glance next to offline's plain outline.
    const status = (camera.connectivity_status || '').toLowerCase();
    const statusColorClass =
      status === 'online' ? 'text-signal-green' : status === 'offline' ? 'text-signal-red' : '';
    return (
      <div key={camera.id} className="relative pl-4 group">
        <TreeLines isLast={isLast} />
        <div
          className={`flex items-center gap-1 hover:bg-panel-raised ${
            isCameraSelected ? 'bg-command/10 text-command' : 'text-slate-500'
          }`}
        >
          <button
            type="button"
            draggable={enableDrag}
            onDragStart={enableDrag ? startCameraDrag([camera.id]) : undefined}
            title={enableDrag ? `Drag to watch ${camera.name}` : undefined}
            onClick={() => onSelect({ type: 'camera', value: camera.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(camera, { x: e.clientX, y: e.clientY });
            }}
            className={`flex items-center gap-1.5 flex-1 min-w-0 py-1.5 text-left truncate ${
              enableDrag ? 'cursor-grab active:cursor-grabbing' : ''
            }`}
          >
            <Video
              size={10}
              className={`shrink-0 ${statusColorClass}`}
              fill={status === 'online' ? 'currentColor' : 'none'}
            />
            <span className="truncate">{camera.name}</span>
          </button>
          <button
            type="button"
            aria-label={`${camera.name} actions`}
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openMenu(camera, { x: rect.left, y: rect.bottom + 4 });
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 mr-1.5 text-slate-500 hover:text-white shrink-0 rounded"
          >
            <MoreVertical size={12} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
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

      <button
        type="button"
        onClick={() => onSelect(null)}
        title={`Show every camera in ${STATE_NAME}`}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-slate-200 font-semibold hover:bg-panel-raised hover:text-white text-left"
      >
        <Landmark size={12} className="shrink-0" />
        <span className="truncate">{STATE_NAME}</span>
      </button>
      <div className="pl-4">
      {orderedDistricts.map((district, di) => {
        const districtAreasAll = areasByDistrict.get(district) ?? [];
        const unassignedCamerasAll = unassignedCamerasByDistrict.get(district) ?? [];

        const districtLocalTerm = (districtSearch[district] ?? '').trim().toLowerCase();
        const isDistrictLocalOpen = district in districtSearch;
        const isLocalSearching = districtLocalTerm.length > 0;

        // With a search active (global or this district's own local box),
        // only keep areas/cameras that actually contain a match, and
        // force this branch open so the officer never has to click through
        // to see a result that's already found. The two searches stay
        // independent -- local search matching by camera id too (the
        // universal bar deliberately doesn't, left as-is) never changes
        // what the universal bar alone would have shown.
        const districtAreas = (isSearching || isLocalSearching)
          ? districtAreasAll.filter((c) => {
              const camsHere = camerasByArea.get(c.id) ?? [];
              const matchesGlobal = isSearching && (camsHere.some((cam) => matchesTerm(cam.name)) || matchesTerm(c.name));
              const matchesLocal =
                isLocalSearching &&
                (camsHere.some((cam) => cameraMatchesLocal(cam, districtLocalTerm)) ||
                  textMatches(c.name, districtLocalTerm));
              return matchesGlobal || matchesLocal;
            })
          : districtAreasAll;
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
        if (isSearching && !isLocalSearching && districtAreas.length === 0 && unassignedCameras.length === 0) {
          return null;
        }

        const isLastDistrict = di === orderedDistricts.length - 1;
        const isDistrictExpanded = isSearching || isLocalSearching || !collapsedDistricts.has(district);
        const isDistrictSelected = selected?.type === 'district' && selected.value === district;
        const hasNoChildren = districtAreas.length === 0 && unassignedCameras.length === 0;
        // Every camera in this district, assigned to an area or not -- what
        // a drag of the whole district row hands the drop target (Dashboard/
        // Archive grid). Uses the unfiltered *All lists, not the possibly
        // search-narrowed ones: dragging "this district" means every camera
        // in it, regardless of an unrelated search term.
        const districtCameraIds = [
          ...districtAreasAll.flatMap((c) => (camerasByArea.get(c.id) ?? []).map((cam) => cam.id)),
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
                draggable={enableDrag && districtCameraIds.length > 0}
                onDragStart={enableDrag ? startCameraDrag(districtCameraIds) : undefined}
                title={enableDrag && districtCameraIds.length > 0 ? `Drag to watch all ${districtCameraIds.length} camera(s) in ${district}` : undefined}
                onClick={() => {
                  onSelect({ type: 'district', value: district });
                  if (!hasNoChildren) toggleDistrict(district);
                }}
                className={`flex items-center gap-1.5 flex-1 min-w-0 text-left truncate ${enableDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
              >
                <Building2 size={12} className="shrink-0" />
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
                  {districtAreas.map((area, i) => {
                    const isLastArea = i === districtAreas.length - 1 && unassignedCameras.length === 0;
                    const isAreaSelected = selected?.type === 'area' && selected.value === area.id;
                    const areaCamerasAll = camerasByArea.get(area.id) ?? [];
                    const areaCameras = (isSearching || isLocalSearching)
                      ? areaCamerasAll.filter(
                          (cam) =>
                            (isSearching && matchesTerm(cam.name)) ||
                            (isLocalSearching && cameraMatchesLocal(cam, districtLocalTerm))
                        )
                      : areaCamerasAll;
                    const isAreaExpanded = isSearching || isLocalSearching || !collapsedAreas.has(area.id);
                    return (
                      <div key={area.id} className="relative pl-4">
                        <TreeLines isLast={isLastArea} />
                        <div
                          className={`flex items-center gap-1 py-1.5 hover:bg-panel-raised ${
                            isAreaSelected ? 'bg-command/10 text-command' : 'text-slate-400'
                          }`}
                        >
                          {areaCameras.length > 0 ? (
                            <button
                              type="button"
                              aria-label={isAreaExpanded ? `Collapse ${area.name}` : `Expand ${area.name}`}
                              onClick={() => toggleArea(area.id)}
                              className="p-0.5 text-slate-500 hover:text-white shrink-0"
                            >
                              {isAreaExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            </button>
                          ) : (
                            <span className="inline-block w-[15px] shrink-0" aria-hidden />
                          )}
                          <button
                            type="button"
                            draggable={enableDrag && areaCamerasAll.length > 0}
                            onDragStart={enableDrag ? startCameraDrag(areaCamerasAll.map((cam) => cam.id)) : undefined}
                            title={enableDrag && areaCamerasAll.length > 0 ? `Drag to watch all ${areaCamerasAll.length} camera(s) in ${area.name}` : undefined}
                            onClick={() => {
                              onSelect({ type: 'area', value: area.id });
                              if (areaCameras.length > 0) toggleArea(area.id);
                            }}
                            className={`flex items-center gap-1.5 flex-1 min-w-0 text-left truncate ${enableDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
                          >
                            <MapPin size={11} className="shrink-0" />
                            <span className="truncate">{area.name}</span>
                          </button>
                        </div>
                        {isAreaExpanded && areaCameras.length > 0 && (
                          <div className="pl-4">
                            {areaCameras.map((camera, j) =>
                              renderCameraRow(camera, j === areaCameras.length - 1)
                            )}
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
                            {unassignedCameras.map((camera, j) =>
                              renderCameraRow(camera, j === unassignedCameras.length - 1)
                            )}
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
        const districtAreasAll = areasByDistrict.get(district) ?? [];
        const unassignedCamerasAll = unassignedCamerasByDistrict.get(district) ?? [];
        const hasMatch =
          districtAreasAll.some((c) => (camerasByArea.get(c.id) ?? []).some((cam) => matchesTerm(cam.name)) || matchesTerm(c.name)) ||
          unassignedCamerasAll.some((cam) => matchesTerm(cam.name));
        return !hasMatch;
      }) && (
        <p className="px-2 py-4 text-slate-600 italic text-center">No cameras match &quot;{searchTerm}&quot;</p>
      )}
      </div>
    </nav>

    {menuState && (() => {
      const menuCameraInScope = isInScope(scopeType, scopeValue, menuState.camera.dept);
      return (
        <CameraContextMenu
          camera={menuState.camera}
          anchor={menuState.anchor}
          onClose={() => setMenuState(null)}
          canManage={canManageCameras && menuCameraInScope}
          outOfScope={canManageCameras && !menuCameraInScope}
          onPlay={onPlayCamera ? () => onPlayCamera(menuState.camera.id) : undefined}
          onViewDetails={() => setDetailCamera(menuState.camera)}
          onConfigure={() => setConfigureCamera(menuState.camera)}
        />
      );
    })()}
    {detailCamera && <CameraDetailModal camera={detailCamera} onClose={() => setDetailCamera(null)} />}
    {configureCamera && (
      <ConfigureCameraModal
        camera={configureCamera}
        districts={districts}
        areas={areas}
        onClose={() => setConfigureCamera(null)}
      />
    )}
    </>
  );
}

export default DistrictAreaTree;
