'use client';

import React, { useState } from 'react';
import { X, Plus, CheckCircle2 } from 'lucide-react';
import { createCoverageTarget, CoverageTarget } from '@/services/coverageTargetsService';

const emptyForm: Omit<CoverageTarget, 'id'> = {
  name: '',
  lat: 0,
  long: 0,
  district: '',
  priority: 'medium',
};

export default function AddCoverageTargetModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState<Omit<CoverageTarget, 'id'>>(emptyForm);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mapClickMode, setMapClickMode] = useState(false);

  const handleMapClick = async () => {
    setMapClickMode(true);
    // In a real implementation, this would activate a map picker
    // For now, we just show the instruction
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await createCoverageTarget(form);
      setAdded(true);
      setForm(emptyForm);
      setTimeout(() => {
        setAdded(false);
        onSuccess();
      }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create coverage target');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition';
  const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-coverage-target-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="add-coverage-target-title" className="text-sm font-semibold text-white tracking-wide">
            Add Coverage Target
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-panel-raised"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              placeholder="e.g., Downtown intersection 5th & Main"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Latitude</label>
              <input
                className={`${inputClass} font-mono`}
                placeholder="e.g., 23.1815"
                type="number"
                step="0.0001"
                value={form.lat || ''}
                onChange={(e) => setForm({ ...form, lat: e.target.value ? Number(e.target.value) : 0 })}
                required
              />
            </div>
            <div>
              <label className={labelClass}>Longitude</label>
              <input
                className={`${inputClass} font-mono`}
                placeholder="e.g., 72.6369"
                type="number"
                step="0.0001"
                value={form.long || ''}
                onChange={(e) => setForm({ ...form, long: e.target.value ? Number(e.target.value) : 0 })}
                required
              />
            </div>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Click the map icon to set location by clicking on the map, or enter latitude and longitude manually.
          </p>

          <div>
            <label className={labelClass}>District</label>
            <input
              className={inputClass}
              placeholder="e.g., Ahmedabad City"
              value={form.district}
              onChange={(e) => setForm({ ...form, district: e.target.value })}
              required
            />
          </div>

          <div>
            <label className={labelClass}>Priority</label>
            <select
              className={inputClass}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          {error && <p className="text-[11px] text-signal-red">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full flex items-center justify-center gap-1.5 bg-command hover:bg-command-dim disabled:opacity-50 text-white text-xs font-semibold py-2 rounded transition"
          >
            <Plus size={14} />
            {isSubmitting ? 'Adding…' : 'Add Coverage Target'}
          </button>

          {added && (
            <p className="flex items-center gap-1.5 text-[11px] text-signal-green">
              <CheckCircle2 size={12} /> Coverage target added successfully.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
