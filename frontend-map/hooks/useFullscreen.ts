'use client';

import { useCallback, useEffect, useState } from 'react';

/** True OS/browser fullscreen (Fullscreen API) -- distinct from the
 * in-page "immersive" chrome-hiding (ImmersiveModeContext): this
 * additionally hides the browser's own tab bar/URL bar, for "the entire
 * screen" rather than just the page content. Tracks the real
 * document.fullscreenElement state (not just "did we last call request")
 * so it stays correct if the officer exits with Esc instead of the button. */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enter = useCallback(() => {
    document.documentElement.requestFullscreen?.().catch(() => {
      // Denied/unsupported (e.g. an iframe without allowfullscreen) -- the
      // in-page immersive mode still applies, so this is a soft failure.
    });
  }, []);

  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) exit();
    else enter();
  }, [enter, exit]);

  return { isFullscreen, enter, exit, toggle };
}
