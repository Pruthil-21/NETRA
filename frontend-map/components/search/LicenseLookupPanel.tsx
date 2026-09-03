'use client';

import React, { useState } from 'react';
import { IdCard, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { SarathiDetails } from '@/types/ownerDetails';
import { licenseLookupService } from '@/services/licenseLookupService';

// Standalone driving-license lookup (SARTHI) -- deliberately separate from
// VehicleSearchPanel's plate search: a DL number never comes from a camera
// detection or an alert, an officer types it in directly, so this has no
// connection to the sightings/owner-lookup flow above it.
export const LicenseLookupPanel: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [dlNumber, setDlNumber] = useState('');
  const [result, setResult] = useState<SarathiDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runLookup = async () => {
    const dl = dlNumber.trim().toUpperCase();
    if (!dl) return;
    setIsLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await licenseLookupService.lookup(dl));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to look up license');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runLookup();
  };

  return (
    <div className="p-3 bg-slate-900 border-b border-slate-800">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase hover:text-slate-200 transition"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <IdCard size={12} />
        Driving License Lookup (SARTHI)
      </button>

      {expanded && (
        <div className="mt-2">
          <input
            type="text"
            aria-label="Search by driving license number"
            placeholder="Enter DL number"
            value={dlNumber}
            onChange={(e) => setDlNumber(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 uppercase focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition"
          />
          <button
            type="button"
            onClick={runLookup}
            disabled={isLoading || !dlNumber.trim()}
            className="mt-2 w-full py-1.5 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded transition"
          >
            {isLoading ? 'Looking up…' : 'Look Up License'}
          </button>

          {error && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-400">
              <AlertTriangle size={11} />
              {error}
            </div>
          )}

          {result && (
            <div className="mt-2 text-[11px] bg-slate-950/60 border border-slate-800 rounded px-2.5 py-2">
              {result.status !== 'ok' ? (
                <p className="text-slate-500">Not available yet — SARTHI access hasn&apos;t been set up.</p>
              ) : (
                <div className="flex flex-col gap-0.5 text-slate-400">
                  <div>Holder: {result.holder_name || 'Unknown'}</div>
                  <div>Class: {result.license_class || 'Unknown'}</div>
                  {result.issue_date && <div className="text-slate-500">Issued: {result.issue_date}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LicenseLookupPanel;
