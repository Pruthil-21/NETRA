'use client';

import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { RecordingSegment } from '@/services/recordingsService';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** YYYY-MM-DD in the viewer's own timezone -- recordings are browsed by the
 * day an officer thinks of them as ("Tuesday night"), not by UTC date. */
export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface RecordingCalendarProps {
  /** The full set of segments for the selected camera, unfiltered -- used
   * only to mark which days have anything recorded. */
  segments: RecordingSegment[];
  selectedDate: string;
  onSelectDate: (dateKey: string) => void;
}

export function RecordingCalendar({ segments, selectedDate, onSelectDate }: RecordingCalendarProps) {
  const selected = useMemo(() => new Date(`${selectedDate}T00:00:00`), [selectedDate]);
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());

  const datesWithRecordings = useMemo(() => {
    const set = new Set<string>();
    for (const segment of segments) {
      set.add(toLocalDateKey(new Date(segment.start)));
    }
    return set;
  }, [segments]);

  const todayKey = toLocalDateKey(new Date());

  const cells = useMemo(() => {
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const leadingBlanks = firstOfMonth.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const result: (string | null)[] = Array(leadingBlanks).fill(null);
    for (let day = 1; day <= daysInMonth; day++) {
      result.push(toLocalDateKey(new Date(viewYear, viewMonth, day)));
    }
    return result;
  }, [viewYear, viewMonth]);

  const goToMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric',
  });

  return (
    <div className="w-64 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => goToMonth(-1)}
          className="p-1 text-slate-400 hover:text-white rounded hover:bg-panel-raised"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-semibold text-white">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => goToMonth(1)}
          className="p-1 text-slate-400 hover:text-white rounded hover:bg-panel-raised"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_LABELS.map((label, i) => (
          <span key={i} className="text-[10px] text-slate-600">{label}</span>
        ))}
        {cells.map((dateKey, i) => {
          if (dateKey === null) return <span key={`blank-${i}`} />;
          const hasRecordings = datesWithRecordings.has(dateKey);
          const isFuture = dateKey > todayKey;
          const isSelected = dateKey === selectedDate;
          const dayNumber = Number(dateKey.slice(-2));
          return (
            <button
              key={dateKey}
              type="button"
              disabled={isFuture}
              onClick={() => onSelectDate(dateKey)}
              aria-label={hasRecordings ? `${dateKey}, has recordings` : dateKey}
              className={`relative text-[11px] py-1.5 rounded ${
                isSelected
                  ? 'bg-command/20 text-command font-semibold'
                  : isFuture
                    ? 'text-slate-700 cursor-not-allowed'
                    : hasRecordings
                      ? 'text-white hover:bg-panel-raised'
                      : 'text-slate-600 hover:bg-panel-raised'
              }`}
            >
              {dayNumber}
              {hasRecordings && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-command" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
