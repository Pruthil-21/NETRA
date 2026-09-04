import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { FeedCard } from '@/components/dashboard/FeedCard';
import { CameraFeed } from '@/types/stream';

const FEED: CameraFeed = {
  id: '43', name: 'Cam A', department: 'Traffic', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/a.m3u8', status: 'ONLINE',
};

describe('FeedCard hover-to-play', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hoverOnly mode calls onHoverStart after the hold delay, not immediately', () => {
    vi.useFakeTimers();
    const onHoverStart = vi.fn();
    render(<FeedCard feed={FEED} mode="hoverOnly" onHoverStart={onHoverStart} onHoverEnd={() => {}} />);

    fireEvent.mouseEnter(screen.getByTestId('feed-card-viewport'));
    expect(onHoverStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(onHoverStart).toHaveBeenCalledWith(FEED.id);
    expect(screen.queryByTestId('hls-player')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('hoverOnly mode calls onHoverEnd after the grace period following mouse-leave', () => {
    vi.useFakeTimers();
    const onHoverEnd = vi.fn();
    render(<FeedCard feed={FEED} mode="hoverOnly" onHoverStart={() => {}} onHoverEnd={onHoverEnd} />);

    fireEvent.mouseEnter(screen.getByTestId('feed-card-viewport'));
    vi.advanceTimersByTime(2000); // past the hold delay, hover is now "active"
    fireEvent.mouseLeave(screen.getByTestId('feed-card-viewport'));
    expect(onHoverEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1200); // past the grace period
    expect(onHoverEnd).toHaveBeenCalledWith(FEED.id);
    vi.useRealTimers();
  });

  it('playAll mode renders HlsPlayer when isPlaying is true, with no hover needed', () => {
    render(<FeedCard feed={FEED} mode="playAll" isPlaying />);
    expect(screen.getByTestId('hls-player')).toBeInTheDocument();
  });
});
