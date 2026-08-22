"use client";

import { Header } from "@/components/common/Header";
import { CameraGrid } from "@/components/dashboard/CameraGrid";
import { MOCK_FEEDS } from "@/config/streams";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold text-white">Live Operations Feeds</h2>
            <p className="text-xs text-gray-400">Phase 0 Baseline Stream Verification</p>
          </div>
        </div>
        <CameraGrid feeds={MOCK_FEEDS} />
      </main>
    </div>
  );
}