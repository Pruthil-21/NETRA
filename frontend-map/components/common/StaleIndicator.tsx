'use client';

import React from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useStaleness } from '@/hooks/useStaleness';

interface StaleIndicatorProps {
  lastUpdated: Date | null;
  hasError: boolean;
  pollIntervalMs: number;
}

/** "Updated Xs ago" -- quiet and mono when data's fresh, amber and explicit
 * once it's overdue. The label alone isn't enough on its own to flag a
 * problem at a glance, which is why callers also dim their own tile/header
 * off isStale rather than relying on someone reading this text. */
export function StaleIndicator({ lastUpdated, hasError, pollIntervalMs }: StaleIndicatorProps) {
  const { isStale, label } = useStaleness(lastUpdated, hasError, pollIntervalMs);

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono ${
        isStale ? 'text-signal-amber' : 'text-slate-500'
      }`}
    >
      {isStale ? <AlertCircle size={10} /> : <RefreshCw size={10} />}
      {label}
    </span>
  );
}

export { useStaleness };
