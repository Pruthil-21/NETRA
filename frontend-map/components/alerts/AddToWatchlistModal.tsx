'use client';

import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { watchlistService } from '@/services/watchlistService';
import { WatchlistPriority } from '@/types/alert';

interface AddToWatchlistModalProps {
  onClose: () => void;
  onAdded: () => void;
  /** Pre-fills the plate field — e.g. "blacklist this plate" from a search result. */
  initialPlate?: string;
}

export function AddToWatchlistModal({ onClose, onAdded, initialPlate }: AddToWatchlistModalProps) {
  const { cameras } = useCameraRegistry();
  const cities = useMemo(
    () => Array.from(new Set(cameras.map((c) => c.dept).filter(Boolean))).sort(),
    [cameras]
  );

  const [plateNumber, setPlateNumber] = useState(initialPlate || '');
  const [reason, setReason] = useState('');
  const [deptFlagged, setDeptFlagged] = useState(cities[0] || '');
  const [priority, setPriority] = useState<WatchlistPriority>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plateNumber.trim() || !reason.trim() || !deptFlagged.trim()) {
      setError('Plate number, reason, and city are all required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await watchlistService.create({
        plate_number: plateNumber.trim().toUpperCase(),
        reason: reason.trim(),
        dept_flagged: deptFlagged.trim(),
        priority,
      });
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add plate to blacklist');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm bg-panel border border-line rounded shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Add to Blacklist</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-400">Plate number</span>
            <input
              value={plateNumber}
              onChange={(e) => setPlateNumber(e.target.value)}
              placeholder="E.G. GJ01AB1234"
              className="bg-panel-raised border border-line rounded px-2.5 py-1.5 text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-command"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-slate-400">Reason</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reported stolen, wanted in case #..."
              className="bg-panel-raised border border-line rounded px-2.5 py-1.5 text-white placeholder:text-slate-600 focus:outline-none focus:border-command"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-slate-400">City / area flagged</span>
            {cities.length > 0 ? (
              <select
                value={deptFlagged}
                onChange={(e) => setDeptFlagged(e.target.value)}
                className="bg-panel-raised border border-line rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-command"
              >
                {cities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={deptFlagged}
                onChange={(e) => setDeptFlagged(e.target.value)}
                placeholder="City or area name"
                className="bg-panel-raised border border-line rounded px-2.5 py-1.5 text-white placeholder:text-slate-600 focus:outline-none focus:border-command"
              />
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-slate-400">Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as WatchlistPriority)}
              className="bg-panel-raised border border-line rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-command"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          {error && <p className="text-signal-red">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-1 px-3 py-2 bg-command text-white rounded font-semibold disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add to Blacklist'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default AddToWatchlistModal;
