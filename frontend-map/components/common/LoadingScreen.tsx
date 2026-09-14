'use client';

import React from 'react';
import Image from 'next/image';

/** Full-viewport loading state shown for the two gaps that otherwise render
 * a blank/white screen: the client-side auth check on first load (before we
 * know whether to show the dashboard or redirect to /login), and Next's own
 * route-segment Suspense boundary (app/loading.tsx) while a page's chunk is
 * still being fetched/compiled. Kept a single component so both places look
 * identical -- an officer shouldn't be able to tell which case they hit.
 *
 * The mark's motion is deliberately restrained: a slow, single radar-sweep
 * ring (this app's one ambient-motion signature, reused from live-camera
 * markers -- see globals.css) plus a gentle opacity breathe on the mark
 * itself. No spin, no bounce -- this is a police operations tool, not a
 * marketing splash screen. */
export function LoadingScreen() {
  return (
    <main className="min-h-screen w-full bg-ink flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-5">
        <div className="relative radar-sweep-brand inline-flex items-center justify-center">
          <Image
            src="/logo-mark.png"
            alt="DIGDHRISHTI"
            width={64}
            height={64}
            priority
            className="animate-pulse"
          />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-bold text-white tracking-wider">DIGDHRISHTI</h1>
          <p className="text-xs text-slate-500 mt-1">Establishing secure session…</p>
        </div>
        <div className="w-40 h-1 bg-line rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-command rounded-full animate-[loading-bar_1.1s_ease-in-out_infinite]" />
        </div>
      </div>
    </main>
  );
}

export default LoadingScreen;
