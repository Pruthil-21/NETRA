'use client';

import React, { useEffect, useState } from 'react';
import { Search, MapPin, AlertTriangle } from 'lucide-react';
import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';
import { detectionService } from '@/services/detectionService';

interface VehicleSearchPanelProps {
  cameras: Camera[];
  onResultsChange: (detections: Detection[]) => void;
  onSelectSighting: (camera: Camera) => void;
}

export const VehicleSearchPanel: React.FC<VehicleSearchPanelProps> = ({
  cameras,
  onResultsChange,
  onSelectSighting,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Detection[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onResultsChange(results ?? []);
    // onResultsChange identity isn't stable across parent renders (inline
    // arrow), and only the results value itself should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const cameraById = new Map(cameras.map((cam) => [cam.id, cam]));

  const runSearch = async () => {
    const plate = query.trim().toUpperCase();
    if (!plate) return;

    setIsLoading(true);
    setError(null);
    try {
      const detections = await detectionService.search({ plate_number: plate });
      setResults(detections);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search vehicle sightings');
      setResults(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runSearch();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 bg-slate-900 border-b border-slate-800">
        <label
          htmlFor="plate-search"
          className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1"
        >
          Vehicle Movement Search
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 pointer-events-none"
          />
          <input
            id="plate-search"
            type="text"
            aria-label="Search by plate number"
            placeholder="Enter plate number (e.g. GJ01AB1234)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-slate-950 border border-slate-700 rounded pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition"
          />
        </div>
        <button
          type="button"
          onClick={runSearch}
          disabled={isLoading || !query.trim()}
          className="mt-2 w-full py-1.5 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded transition"
        >
          {isLoading ? 'Searching…' : 'Search Sightings'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="flex flex-col items-center text-center gap-2 p-6 text-rose-400">
            <AlertTriangle size={20} />
            <p className="text-xs font-semibold">Search failed</p>
            <p className="text-[11px] text-slate-400">{error}</p>
          </div>
        ) : results === null ? (
          <div className="p-6 text-center text-xs text-slate-500">
            Search a plate number to see every camera it was sighted at.
          </div>
        ) : results.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No sightings found for &quot;{query.trim().toUpperCase()}&quot;.
          </div>
        ) : (
          <ul>
            {results.map((detection, index) => {
              const camera = cameraById.get(detection.camera_id);
              return (
                <li
                  key={detection.id}
                  onClick={() => camera && onSelectSighting(camera)}
                  className="p-3 cursor-pointer text-xs border-b border-slate-800/60 hover:bg-slate-800/40 transition"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-4 h-4 shrink-0 rounded-full bg-blue-500/20 border border-blue-400 text-blue-300 text-[9px] font-bold flex items-center justify-center">
                      {index + 1}
                    </span>
                    <span className="font-bold text-slate-200 truncate">
                      {camera?.name || `Camera #${detection.camera_id}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-400 pl-6">
                    <MapPin size={11} className="shrink-0" />
                    <span>{new Date(detection.detected_at).toLocaleString()}</span>
                  </div>
                  {detection.confidence != null && (
                    <div className="text-[10px] text-slate-500 pl-6 mt-0.5">
                      Confidence: {(detection.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default VehicleSearchPanel;
