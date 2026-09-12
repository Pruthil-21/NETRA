'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

interface SearchSelectProps<T> {
  id: string;
  label: string;
  items: T[];
  getKey: (item: T) => string | number;
  getLabel: (item: T) => string;
  value: T | null;
  onChange: (item: T) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyMessage?: string;
  /** Omit for client-side filtering of `items` by getLabel(item). Pass this
   * to delegate filtering to the parent instead (e.g. a server-side search
   * over 19,000+ rows) -- `items` is then shown as-is, already filtered. */
  onSearchChange?: (term: string) => void;
  renderExtra?: (item: T) => React.ReactNode;
}

/** Type-to-search combobox: click/focus to open a dropdown of matches,
 * type to filter, click a row to pick it. Same interaction pattern as the
 * Map page's area filter and the Add Camera modal's Area field -- extracted
 * here once a third picker (Areas admin's District/Taluka/Village cascade)
 * made the copy-pasted version worth sharing. */
export function SearchSelect<T>({
  id, label, items, getKey, getLabel, value, onChange, placeholder, disabled, emptyMessage, onSearchChange, renderExtra,
}: SearchSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const visible = useMemo(() => {
    if (onSearchChange) return items;
    const t = term.trim().toLowerCase();
    if (!t) return items;
    return items.filter((item) => getLabel(item).toLowerCase().includes(t));
  }, [items, term, onSearchChange, getLabel]);

  const handleTermChange = (next: string) => {
    setTerm(next);
    onSearchChange?.(next);
  };

  return (
    <div className="relative" ref={ref}>
      <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        aria-label={label}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command disabled:opacity-40 disabled:cursor-not-allowed"
        value={open ? term : value ? getLabel(value) : ''}
        onFocus={() => {
          setOpen(true);
          setTerm('');
          onSearchChange?.('');
        }}
        onChange={(e) => handleTermChange(e.target.value)}
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto bg-ink border border-line rounded shadow-lg">
          {visible.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-slate-600 italic">{emptyMessage ?? 'No matches.'}</p>
          ) : (
            visible.map((item) => (
              <button
                key={getKey(item)}
                type="button"
                onClick={() => {
                  onChange(item);
                  setTerm('');
                  setOpen(false);
                }}
                className="w-full text-left px-2.5 py-1.5 text-xs text-slate-200 hover:bg-panel-raised flex items-center justify-between gap-2"
              >
                <span className="truncate">{getLabel(item)}</span>
                {renderExtra?.(item)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default SearchSelect;
