'use client';

import React from 'react';
import { User, ShieldAlert } from 'lucide-react';
import { VehicleGovtLookup } from '@/types/ownerDetails';

interface OwnerDetailsPanelProps {
  details: VehicleGovtLookup | null | undefined;
  isLoading?: boolean;
}

// Shared by the manual plate-search panel and the alerts list -- both show
// the same VAHAN + eGujCop fields, so one component keeps the "not yet
// configured" copy consistent instead of repeating it twice.
export const OwnerDetailsPanel: React.FC<OwnerDetailsPanelProps> = ({ details, isLoading }) => {
  if (isLoading) {
    return <div className="text-[11px] text-slate-500 px-3 py-2">Looking up owner + police records…</div>;
  }
  if (!details) return null;

  const { vahan, egujcop } = details;

  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-[11px] bg-slate-900/60 border border-slate-800 rounded">
      <div>
        <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
          <User size={12} />
          Owner details (VAHAN)
        </div>
        {vahan.status !== 'ok' ? (
          <p className="text-slate-500 mt-0.5">Not available yet — VAHAN access hasn&apos;t been set up.</p>
        ) : (
          <div className="mt-0.5">
            <div className="text-slate-400">Owner: {vahan.owner_name || 'Unknown'}</div>
            <div className="text-slate-400">Vehicle: {vahan.vehicle_model || 'Unknown'}</div>
            {vahan.registration_date && (
              <div className="text-slate-500">Registered: {vahan.registration_date}</div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
          <ShieldAlert size={12} />
          Police records (eGujCop)
        </div>
        {egujcop.status !== 'ok' ? (
          <p className="text-slate-500 mt-0.5">Not available yet — eGujCop access hasn&apos;t been set up.</p>
        ) : egujcop.has_open_case ? (
          <div className="mt-0.5 text-amber-400">
            Open case(s): {egujcop.case_ids?.join(', ') || 'yes'}
          </div>
        ) : (
          <div className="mt-0.5 text-slate-400">No open cases found.</div>
        )}
      </div>
    </div>
  );
};

export default OwnerDetailsPanel;
