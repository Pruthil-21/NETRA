'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, X, Search, Check } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { circlesService, Circle } from '@/services/circlesService';
import { COVERAGE_LEGEND, COVERAGE_COLORS, COVERAGE_RADIUS_METERS } from '@/lib/coverageMath';
import { DENSITY_WINDOW_OPTIONS, formatDensityHour } from '@/lib/densityMath';
import { MapLayer } from '@/types/filters';
import { DensityLoadStatus } from './DensityCanvasLayer';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
] as const;

const LAYER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'coverage', label: 'Coverage' },
  { value: 'density', label: 'Density' },
] as const;

const DENSITY_MODE_OPTIONS = [
  { value: 'live', label: 'Live' },
  { value: 'hour', label: 'By hour' },
] as const;

type LocationRow =
  | { kind: 'city'; key: string; label: string; searchText: string }
  | { kind: 'area'; key: number; label: string; district: string; searchText: string };

/** Google Maps-style filter chip for the map view: one button, top-right of
 * the map, opens a small panel of filters that combine with AND across
 * categories -- picking Offline and a city means "offline cameras in that
 * city." Location itself is OR-combined and multi-select (any selected city
 * OR any selected area passes), searched Paytm-boarding-point style: type to
 * narrow a flat list of cities and areas, tap to add, remove via its chip.
 * Reuses CameraRegistryContext's filters/setFilters -- the same state
 * CameraFilterBar used to drive before it was removed from the sidebar --
 * so this is a new presentation over machinery that was never deleted.
 * Only ever narrows what CameraMap renders; the sidebar tree deliberately
 * keeps showing the full registry regardless. */
interface MapFilterControlProps {
  /** Latest fetch outcome from the density layer, or null while it isn't
   * active -- see app/map/page.tsx, which owns this state since
   * DensityCanvasLayer is a sibling of this component, not an ancestor.
   * Surfaced here so a permission error or network failure reads as an
   * explicit message instead of a silently empty map. */
  densityStatus?: DensityLoadStatus | null;
}

export function MapFilterControl({ densityStatus }: MapFilterControlProps = {}) {
  const { cameras, filters, setFilters } = useCameraRegistry();
  const [open, setOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [circles, setCircles] = useState<Circle[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const locationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: areas just won't be searchable/selectable until this
      // succeeds/retries -- cities (departments) still work either way.
    });
  }, []);

  const locationRows = useMemo<LocationRow[]>(() => {
    const cityNames = Array.from(new Set(cameras.map((c) => c.dept).filter(Boolean))) as string[];
    const cityRows: LocationRow[] = cityNames
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ kind: 'city', key: name, label: name, searchText: name.toLowerCase() }));
    const areaRows: LocationRow[] = [...circles]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((circle) => ({
        kind: 'area',
        key: circle.id,
        label: circle.name,
        district: circle.district,
        searchText: `${circle.name} ${circle.district}`.toLowerCase(),
      }));
    return [...cityRows, ...areaRows];
  }, [cameras, circles]);

  const visibleRows = useMemo(() => {
    const term = locationSearch.trim().toLowerCase();
    if (!term) return locationRows;
    return locationRows.filter((row) => row.searchText.includes(term));
  }, [locationRows, locationSearch]);

  const selectedCities = filters.departments;
  const selectedAreaIds = filters.circleIds;
  const selectedAreas = useMemo(
    () => circles.filter((c) => selectedAreaIds.includes(c.id)),
    [circles, selectedAreaIds]
  );

  const activeCount =
    (filters.mapLayer !== 'none' ? 1 : 0) +
    (filters.mapLayer === 'none' && filters.connectivity !== 'all' ? 1 : 0) +
    selectedCities.length +
    selectedAreaIds.length;

  // One listener pair covers both layers: the location dropdown is the
  // innermost, so a click/Escape closes just it when it's open, leaving the
  // rest of the filter panel in place -- only a click truly outside the
  // whole panel (or Escape with the dropdown already closed) closes the
  // panel itself. Depends on both `open` and `locationOpen` so the closure
  // always reads their current values instead of stale ones from whenever
  // the listener was first attached.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Truly outside the whole panel (e.g. the map itself) dismisses both
      // layers at once -- only a click that's still inside the panel but
      // outside the location area (e.g. a Status button) dismisses just the
      // dropdown, leaving the rest of the panel open.
      if (!containerRef.current?.contains(target)) {
        setOpen(false);
        setLocationOpen(false);
        return;
      }
      if (locationOpen && !locationRef.current?.contains(target)) {
        setLocationOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (locationOpen) setLocationOpen(false);
      else setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, locationOpen]);

  const toggleCity = (name: string) => {
    setFilters((prev) => ({
      ...prev,
      departments: prev.departments.includes(name)
        ? prev.departments.filter((d) => d !== name)
        : [...prev.departments, name],
    }));
  };

  const toggleArea = (id: number) => {
    setFilters((prev) => ({
      ...prev,
      circleIds: prev.circleIds.includes(id)
        ? prev.circleIds.filter((c) => c !== id)
        : [...prev.circleIds, id],
    }));
  };

  const handleReset = () => {
    setFilters((prev) => ({
      ...prev,
      connectivity: 'all',
      departments: [],
      circleIds: [],
      mapLayer: 'none',
      densityMode: 'live',
      densityWindowMinutes: 30,
      densityHour: new Date().getHours(),
    }));
    setLocationSearch('');
    setLocationOpen(false);
  };

  // Coverage and Density are full-canvas layers (see CameraMap's
  // hideMarkers/coverage/density props) -- selecting either one forces
  // Status back to 'all' so the layer classifies every camera itself
  // instead of the map showing a Status-narrowed pin subset underneath it.
  const setMapLayer = (layer: MapLayer) => {
    setFilters((prev) => ({ ...prev, mapLayer: layer, connectivity: layer === 'none' ? prev.connectivity : 'all' }));
  };

  return (
    <div ref={containerRef} className="absolute top-3 right-3 z-[1000]">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setLocationOpen(false);
        }}
        aria-expanded={open}
        aria-label="Camera filters"
        className={`flex items-center gap-1.5 pl-3 pr-2.5 py-2 rounded-full border shadow-lg text-xs font-semibold transition ${
          activeCount > 0
            ? 'bg-command text-white border-command'
            : 'bg-panel text-slate-200 border-line hover:bg-panel-raised'
        }`}
      >
        <SlidersHorizontal size={13} />
        Filters
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-white/20 text-[10px] font-bold">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-lg bg-panel border border-line shadow-xl p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Filters</span>
            <button
              type="button"
              aria-label="Close filters"
              onClick={() => {
                setOpen(false);
                setLocationOpen(false);
              }}
              className="text-slate-500 hover:text-white p-0.5"
            >
              <X size={13} />
            </button>
          </div>

          <div className={filters.mapLayer !== 'none' ? 'opacity-40 pointer-events-none' : undefined}>
            <span className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1.5">
              Status
            </span>
            <div role="group" aria-label="Filter by status" className="flex gap-1.5">
              {STATUS_OPTIONS.map((opt) => {
                const isActive = (filters.connectivity || 'all') === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={isActive}
                    disabled={filters.mapLayer !== 'none'}
                    onClick={() => setFilters((prev) => ({ ...prev, connectivity: opt.value }))}
                    className={`flex-1 py-1 rounded-full text-[11px] font-semibold border transition ${
                      isActive
                        ? 'bg-command text-white border-command'
                        : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1.5">
              Map layer
            </span>
            <div role="group" aria-label="Map layer" className="flex gap-1.5 mb-1.5">
              {LAYER_OPTIONS.map((opt) => {
                const isActive = filters.mapLayer === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setMapLayer(opt.value)}
                    className={`flex-1 py-1 rounded-full text-[11px] font-semibold border transition ${
                      isActive
                        ? 'bg-command text-white border-command'
                        : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {filters.mapLayer === 'coverage' && (
              <>
                <div className="flex flex-col gap-1 mb-1.5">
                  {COVERAGE_LEGEND.map(({ status, label }) => (
                    <div key={status} className="flex items-center gap-1.5 text-[11px] text-slate-300">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: COVERAGE_COLORS[status] }}
                        aria-hidden
                      />
                      {label}
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 leading-snug">
                  Approximate -- {COVERAGE_RADIUS_METERS}m assumed radius per camera, not a measured
                  survey. Gujarat only.
                </p>
              </>
            )}

            {filters.mapLayer === 'density' && (
              <div className="space-y-1.5">
                <div role="group" aria-label="Density mode" className="flex gap-1.5">
                  {DENSITY_MODE_OPTIONS.map((opt) => {
                    const isActive = filters.densityMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => setFilters((prev) => ({ ...prev, densityMode: opt.value }))}
                        className={`flex-1 py-1 rounded-full text-[11px] font-semibold border transition ${
                          isActive
                            ? 'bg-command text-white border-command'
                            : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {filters.densityMode === 'live' ? (
                  <div role="group" aria-label="Rolling window" className="flex gap-1.5">
                    {DENSITY_WINDOW_OPTIONS.map((minutes) => {
                      const isActive = filters.densityWindowMinutes === minutes;
                      return (
                        <button
                          key={minutes}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => setFilters((prev) => ({ ...prev, densityWindowMinutes: minutes }))}
                          className={`flex-1 py-1 rounded-full text-[11px] font-semibold border transition ${
                            isActive
                              ? 'bg-command text-white border-command'
                              : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                          }`}
                        >
                          {minutes}m
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold text-slate-200">
                        {formatDensityHour(filters.densityHour)}
                      </span>
                      <span className="text-[10px] text-slate-500">Today, IST</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={23}
                      step={1}
                      value={filters.densityHour}
                      aria-label="Hour of day"
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, densityHour: Number(e.target.value) }))
                      }
                      className="w-full accent-command"
                    />
                  </div>
                )}

                <div
                  className="h-1.5 rounded-full"
                  style={{ background: 'linear-gradient(to right, #22c55e, #f59e0b, #ef4444)' }}
                  aria-hidden
                />
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>Quiet</span>
                  <span>Busiest on screen</span>
                </div>

                {densityStatus?.error && (
                  <p className="text-[10px] text-rose-400 leading-snug">
                    Couldn&apos;t load density data: {densityStatus.error}
                  </p>
                )}
                {!densityStatus?.error && !densityStatus?.loading && densityStatus?.pointCount === 0 && (
                  <p className="text-[10px] text-slate-500 leading-snug">
                    No detections in this window yet.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1.5">
              City or area
            </span>

            {(selectedCities.length > 0 || selectedAreas.length > 0) && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {selectedCities.map((name) => (
                  <span
                    key={`city-${name}`}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-command/20 text-command text-[10px] font-semibold"
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name} filter`}
                      onClick={() => toggleCity(name)}
                      className="hover:text-white"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {selectedAreas.map((area) => (
                  <span
                    key={`area-${area.id}`}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-command/20 text-command text-[10px] font-semibold"
                  >
                    {area.name}
                    <button
                      type="button"
                      aria-label={`Remove ${area.name} filter`}
                      onClick={() => toggleArea(area.id)}
                      className="hover:text-white"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div ref={locationRef}>
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  type="text"
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                  onFocus={() => setLocationOpen(true)}
                  placeholder="Search city or area…"
                  aria-label="Search city or area"
                  className="w-full bg-ink border border-line rounded pl-6 pr-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                />
              </div>

              {locationOpen && (
                <div className="mt-1.5 max-h-40 overflow-y-auto rounded border border-line divide-y divide-line/60">
                  {visibleRows.length === 0 ? (
                    <p className="px-2 py-2 text-[11px] text-slate-600 italic">No matches</p>
                  ) : (
                    visibleRows.map((row) => {
                      const isSelected =
                        row.kind === 'city' ? selectedCities.includes(row.key) : selectedAreaIds.includes(row.key);
                      return (
                        <button
                          key={`${row.kind}-${row.key}`}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => (row.kind === 'city' ? toggleCity(row.key) : toggleArea(row.key))}
                          className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-panel-raised"
                        >
                          <span className="truncate">
                            {row.label}
                            {row.kind === 'area' && (
                              <span className="text-slate-500 text-[10px]"> · {row.district}</span>
                            )}
                          </span>
                          {isSelected && <Check size={12} className="text-command shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={handleReset}
              aria-label="Reset all active filters"
              className="w-full text-center text-[11px] text-slate-400 hover:text-slate-200 hover:bg-panel-raised rounded py-1 transition"
            >
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default MapFilterControl;
