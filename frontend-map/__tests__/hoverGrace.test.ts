import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHoverGraceController } from '@/lib/hoverGrace';

describe('createHoverGraceController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onStart only after holdMs of continuous hover', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const controller = createHoverGraceController(2000, 1200, onStart, onEnd);

    controller.hoverStart();
    vi.advanceTimersByTime(1999);
    expect(onStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('does not call onStart if hoverEnd fires before holdMs elapses', () => {
    const onStart = vi.fn();
    const controller = createHoverGraceController(2000, 1200, onStart, vi.fn());

    controller.hoverStart();
    vi.advanceTimersByTime(1000);
    controller.hoverEnd();
    vi.advanceTimersByTime(5000);

    expect(onStart).not.toHaveBeenCalled();
  });

  it('does not call onEnd if hoverStart fires again within graceMs of a hoverEnd', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const controller = createHoverGraceController(2000, 1200, onStart, onEnd);

    controller.hoverStart();
    vi.advanceTimersByTime(2000);
    expect(onStart).toHaveBeenCalledTimes(1);

    controller.hoverEnd();
    vi.advanceTimersByTime(800); // still inside the 1200ms grace window
    controller.hoverStart(); // re-hover cancels the pending stop
    vi.advanceTimersByTime(5000);

    expect(onEnd).not.toHaveBeenCalled();
  });

  it('calls onEnd once graceMs elapses with no re-hover', () => {
    const onEnd = vi.fn();
    const controller = createHoverGraceController(2000, 1200, vi.fn(), onEnd);

    controller.hoverStart();
    vi.advanceTimersByTime(2000);
    controller.hoverEnd();
    vi.advanceTimersByTime(1199);
    expect(onEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('forceStart calls onStart immediately and cancels any pending timers', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const controller = createHoverGraceController(2000, 1200, onStart, onEnd);

    controller.hoverStart();
    controller.forceStart();
    expect(onStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(onStart).toHaveBeenCalledTimes(1); // the pending hold timer didn't also fire
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('cancel clears any pending start or end without calling either', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const controller = createHoverGraceController(2000, 1200, onStart, onEnd);

    controller.hoverStart();
    controller.cancel();
    vi.advanceTimersByTime(5000);

    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
