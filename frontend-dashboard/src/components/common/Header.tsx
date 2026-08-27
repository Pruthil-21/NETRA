import React from "react";
import { Shield, Activity } from "lucide-react";

export const Header: React.FC = () => {
  return (
    <header className="border-b border-brand-border bg-brand-card px-6 py-4 flex items-center justify-between">
      <div className="flex items-center space-x-3">
        <Shield className="h-7 w-7 text-blue-500" />
        <div>
          <h1 className="text-xl font-bold tracking-wide text-white">NETRA</h1>
          <p className="text-xs text-gray-400">Unified CCTV Integration System — Public Dashboard</p>
        </div>
      </div>
      <div className="flex items-center space-x-2 bg-emerald-950/60 text-emerald-400 border border-emerald-800 px-3 py-1.5 rounded-full text-xs font-semibold">
        <Activity className="w-4 h-4 animate-pulse" />
        <span>SYSTEM OPERATIONAL</span>
      </div>
    </header>
  );
};