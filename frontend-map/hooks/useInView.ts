"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True once the element has scrolled within `rootMargin` of the viewport at least once,
 * and stays true after (a camera that's already loaded shouldn't tear down and reload
 * every time it's scrolled past).
 *
 * Without this, every camera tile mounted its own live HLS.js decoder immediately on
 * page load regardless of whether it was ever actually visible — with 47 registered
 * cameras that meant a dozen-plus simultaneous live video streams decoding at once on
 * first paint, most of them off-screen. This gates playback to "actually looked at."
 */
export function useInView<T extends HTMLElement>(rootMargin = "200px"): [React.RefObject<T>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref as React.RefObject<T>, inView];
}
