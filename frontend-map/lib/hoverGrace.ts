export interface HoverGraceController {
  /** Mouse/pointer entered -- arms the "start after holdMs" timer and cancels any
   * pending stop from a very recent hoverEnd. */
  hoverStart: () => void;
  /** Mouse/pointer left -- arms the "stop after graceMs" timer (cancels a pending
   * start if the hold hadn't elapsed yet). */
  hoverEnd: () => void;
  /** Click/tap equivalent -- starts immediately, no hold, cancels any pending timer. */
  forceStart: () => void;
  /** Unmount/cleanup -- clears any pending timer without firing onStart or onEnd. */
  cancel: () => void;
}

/** Shared timer choreography behind every "hold to preview, brief grace before
 * tearing down" hover interaction in this app (FeedCard's hover-to-play,
 * CameraMap's marker hover-preview). A plain factory, not a hook: CameraMap needs
 * one of these per marker from inside a single component instance (a loop), which
 * a hook can't do -- so this is instantiated once per FeedCard (via a hook wrapper
 * there) and once per camera id in a Map inside CameraMap. */
export function createHoverGraceController(
  holdMs: number,
  graceMs: number,
  onStart: () => void,
  onEnd: () => void
): HoverGraceController {
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };
  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  return {
    hoverStart() {
      clearGrace();
      clearHold();
      holdTimer = setTimeout(onStart, holdMs);
    },
    hoverEnd() {
      clearHold();
      clearGrace();
      graceTimer = setTimeout(onEnd, graceMs);
    },
    forceStart() {
      clearHold();
      clearGrace();
      onStart();
    },
    cancel() {
      clearHold();
      clearGrace();
    },
  };
}
