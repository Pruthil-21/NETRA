"use client";

import React, { useState, useEffect } from "react";
import { WATCHLIST_API_URL } from "@/config/streams";

interface Alert {
  id: string;
  camera_id: string;
  plate_number: string;
  watchlist_id: string;
  matched_at: string;
  status: string;
}

export function AlertBanner() {
  const [activeAlert, setActiveAlert] = useState<Alert | null>(null);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        // HACKATHON SHORTCUT: alerts require an "officer"-role JWT (backend-watchlist has
        // no login endpoint yet), so this is a token minted out-of-band and dropped in via
        // env rather than a real login flow. Replace with a proper auth flow post-hackathon.
        const token = process.env.NEXT_PUBLIC_DEMO_OFFICER_JWT || "";

        const res = await fetch(`${WATCHLIST_API_URL}/alerts`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          console.warn(`Alerts API returned ${res.status} — check NEXT_PUBLIC_DEMO_OFFICER_JWT is a valid officer token.`);
          return;
        }

        const alerts: Alert[] = await res.json();
        const newAlert = alerts.find(
          (a) => a.status === "NEW" && !seenIds.has(a.id)
        );

        if (newAlert) {
          setActiveAlert(newAlert);
          setSeenIds((prev) => new Set(prev).add(newAlert.id));
        }
      } catch (err) {
        console.error("Failed to poll alerts:", err);
      }
    };

    const interval = setInterval(fetchAlerts, 3000);
    return () => clearInterval(interval);
  }, [seenIds]);

  if (!activeAlert) return null;

  return (
    <div className="bg-red-600 text-white px-4 py-3 flex justify-between items-center shadow-lg w-full">
      <div>
        <span className="font-bold">🚨 ALERT: </span>
        Plate <span className="underline font-mono">{activeAlert.plate_number}</span> matched watchlist at Camera <span className="font-semibold">{activeAlert.camera_id}</span>
      </div>
      <button
        onClick={() => setActiveAlert(null)}
        className="bg-red-800 hover:bg-red-900 px-3 py-1 rounded text-sm font-semibold transition-colors"
      >
        Dismiss
      </button>
    </div>
  );
}