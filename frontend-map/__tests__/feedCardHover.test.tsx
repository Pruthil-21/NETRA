import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('starts playing after a 2s hold and stops after leaving for the grace period', () => {
    const { container } = render(<FeedCard feed={FEED} />);
    const tile = container.querySelector('.cursor-pointer')!;

    fireEvent.mouseEnter(tile);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText('Hover or click to play live feed')).not.toBeInTheDocument();

    fireEvent.mouseLeave(tile);
    act(() => vi.advanceTimersByTime(1199));
    expect(screen.queryByText('Hover or click to play live feed')).not.toBeInTheDocument(); // still inside grace

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('Hover or click to play live feed')).toBeInTheDocument(); // grace elapsed, stopped
  });

  it('a quick re-hover within the grace period keeps it playing without a restart', () => {
    const { container } = render(<FeedCard feed={FEED} />);
    const tile = container.querySelector('.cursor-pointer')!;

    fireEvent.mouseEnter(tile);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.mouseLeave(tile);
    act(() => vi.advanceTimersByTime(500)); // inside the 1200ms grace window
    fireEvent.mouseEnter(tile); // re-hover cancels the pending stop

    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('Hover or click to play live feed')).not.toBeInTheDocument();
  });
});
