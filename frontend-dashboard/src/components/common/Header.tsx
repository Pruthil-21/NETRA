import React from "react";
import { Shield, Activity } from "lucide-react";

export type SystemStatus = "operational" | "connecting" | "degraded";

interface HeaderProps {
  status?: SystemStatus;
}

// Was hardcoded to always say "SYSTEM OPERATIONAL" regardless of whether the
// registry/alerts APIs were actually reachable — misleading during exactly the kind
// of backend outage this is meant to warn about.
const STATUS_CONFIG: Record<SystemStatus, { label: string; className: string }> = {
  operational: { label: "SYSTEM OPERATIONAL", className: "bg-emerald-950/60 text-emerald-400 border-emerald-800" },
  connecting: { label: "CONNECTING...", className: "bg-amber-950/60 text-amber-400 border-amber-800" },
  degraded: { label: "CONNECTION ISSUE", className: "bg-red-950/60 text-red-400 border-red-800" },
};

export const Header: React.FC<HeaderProps> = ({ status = "connecting" }) => {
  const config = STATUS_CONFIG[status];

  return (
    <header className="border-b border-brand-border bg-brand-card px-6 py-4 flex items-center justify-between">
      <div className="flex items-center space-x-3">
        <Shield className="h-7 w-7 text-blue-500" />
        <div>
          <h1 className="text-xl font-bold tracking-wide text-white">NETRA</h1>
          <p className="text-xs text-gray-400">Unified CCTV Integration System — Public Dashboard</p>
        </div>
      </div>
      <div className={`flex items-center space-x-2 border px-3 py-1.5 rounded-full text-xs font-semibold ${config.className}`}>
        <Activity className={`w-4 h-4 ${status === "operational" ? "animate-pulse" : ""}`} />
        <span>{config.label}</span>
      </div>
    </header>
  );
};
