import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { FeedCard } from '@/components/dashboard/FeedCard';
import { CameraFeed } from '@/types/stream';

const FEED_A: CameraFeed = {
  id: 'a', name: 'Cam A', department: 'Traffic', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/a.m3u8', status: 'ONLINE',
};
const FEED_B: CameraFeed = {
  id: 'b', name: 'Cam B', department: 'Traffic', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/b.m3u8', status: 'ONLINE',
};

// jsdom doesn't implement a real DataTransfer -- this stand-in carries data
// across the dragStart -> dragOver -> drop sequence the same way the browser's
// real one does, since all three fireEvent calls below share the one instance.
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => { store[type] = value; },
    getData: (type: string) => store[type] ?? '',
    effectAllowed: '',
  } as unknown as DataTransfer;
}

describe('FeedCard drag-to-reorder', () => {
  it('is not draggable when no onReorder is given (focus layout)', () => {
    const { container } = render(<FeedCard feed={FEED_A} />);
    expect(container.firstChild).toHaveAttribute('draggable', 'false');
  });

  it('is draggable when onReorder is given', () => {
    const { container } = render(<FeedCard feed={FEED_A} onReorder={vi.fn()} />);
    expect(container.firstChild).toHaveAttribute('draggable', 'true');
  });

  it('dropping one tile onto another calls onReorder with (draggedId, targetId)', () => {
    const onReorder = vi.fn();
    const { container: containerA } = render(<FeedCard feed={FEED_A} onReorder={onReorder} />);
    const { container: containerB } = render(<FeedCard feed={FEED_B} onReorder={onReorder} />);
    const tileA = containerA.firstChild as HTMLElement;
    const tileB = containerB.firstChild as HTMLElement;

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(tileA, { dataTransfer });
    fireEvent.dragOver(tileB, { dataTransfer });
    fireEvent.drop(tileB, { dataTransfer });

    expect(onReorder).toHaveBeenCalledWith('a', 'b');
  });

  it('dropping a tile onto itself is a no-op call (moveTile ignores same-id)', () => {
    const onReorder = vi.fn();
    const { container } = render(<FeedCard feed={FEED_A} onReorder={onReorder} />);
    const tile = container.firstChild as HTMLElement;

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(tile, { dataTransfer });
    fireEvent.dragOver(tile, { dataTransfer });
    fireEvent.drop(tile, { dataTransfer });

    expect(onReorder).toHaveBeenCalledWith('a', 'a');
  });
});
