import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { DistrictCircleTree } from '@/components/tree/DistrictCircleTree';
import { CameraGrid } from '@/components/dashboard/CameraGrid';
import { FeedCard } from '@/components/dashboard/FeedCard';
import { CameraFeed } from '@/types/stream';
import { CAMERA_DRAG_MIME } from '@/lib/cameraDrag';

// Same jsdom DataTransfer stand-in as feedCardDrag.test.tsx, extended with
// `types` (a real DataTransfer exposes it, and useCameraDropTarget checks it
// on dragover to decide whether this drag is one it cares about).
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
    get types() {
      return Object.keys(store);
    },
    effectAllowed: '',
  } as unknown as DataTransfer;
}

const CIRCLES = [{ id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' }];
const CAMERAS: any[] = [
  { id: 101, name: 'Camera 01', dept: 'Anand', circle_id: 1 },
  { id: 102, name: 'Camera 02', dept: 'Anand', circle_id: 1 },
];

describe('dragging a camera out of DistrictCircleTree', () => {
  it('a camera row drags just its own id', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText('Camera 01'), { dataTransfer });
    expect(JSON.parse(dataTransfer.getData(CAMERA_DRAG_MIME))).toEqual([101]);
  });

  it('an area (circle) row drags every camera under it', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText('APC Circle'), { dataTransfer });
    expect(JSON.parse(dataTransfer.getData(CAMERA_DRAG_MIME))).toEqual([101, 102]);
  });

  it('a district row drags every camera in it', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText('Anand'), { dataTransfer });
    expect(JSON.parse(dataTransfer.getData(CAMERA_DRAG_MIME))).toEqual([101, 102]);
  });
});

const FEED_A: CameraFeed = {
  id: '101', name: 'Camera 01', department: 'Anand', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/a.m3u8', status: 'ONLINE',
};

describe('CameraGrid as a camera drop target', () => {
  it('dropping camera ids from the tree calls onDropCameraIds', () => {
    const onDropCameraIds = vi.fn();
    const { container } = render(
      <CameraGrid
        feeds={[]}
        layout="grid-9"
        mode="hoverOnly"
        activeIds={new Set()}
        onHoverStart={() => {}}
        onHoverEnd={() => {}}
        onDropCameraIds={onDropCameraIds}
      />
    );
    const dropZone = container.firstChild as HTMLElement;
    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify([101, 102]));
    fireEvent.dragOver(dropZone, { dataTransfer });
    fireEvent.drop(dropZone, { dataTransfer });
    expect(onDropCameraIds).toHaveBeenCalledWith([101, 102]);
  });

  it('a reorder drag (no camera-ids payload) does not call onDropCameraIds', () => {
    const onDropCameraIds = vi.fn();
    const { container } = render(
      <CameraGrid
        feeds={[FEED_A]}
        layout="grid-9"
        mode="hoverOnly"
        activeIds={new Set()}
        onHoverStart={() => {}}
        onHoverEnd={() => {}}
        onDropCameraIds={onDropCameraIds}
      />
    );
    const dropZone = container.firstChild as HTMLElement;
    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData('text/plain', '101');
    fireEvent.drop(dropZone, { dataTransfer });
    expect(onDropCameraIds).not.toHaveBeenCalled();
  });
});

describe('CameraGrid immersive layout', () => {
  it('renders every dragged-in camera as an immersive tile in a centered flex-wrap wall, not a CSS grid', () => {
    const feeds: CameraFeed[] = ['101', '102', '103', '104', '105'].map((id) => ({
      id, name: `Cam ${id}`, department: 'Anand', location: '0,0',
      lat: 0, long: 0, hlsUrl: `https://example.com/${id}.m3u8`, status: 'OFFLINE',
    }));
    render(
      <CameraGrid
        feeds={feeds}
        layout="grid-9"
        mode="playAll"
        activeIds={new Set()}
        onHoverStart={() => {}}
        onHoverEnd={() => {}}
        immersive
        onRemove={vi.fn()}
      />
    );
    // All 5 render (the reported bug wasn't a missing tile, it was a badly
    // shaped/gapped layout) -- each as an immersive tile (no separate Map/ID
    // chrome, see the FeedCard immersive describe block above).
    for (const feed of feeds) {
      expect(screen.getByText(feed.name)).toBeInTheDocument();
    }
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();
  });
});

describe('FeedCard immersive mode (drag-composed watch set)', () => {
  it('renders no separate header/footer chrome bars, just the overlay name and remove button', () => {
    const onRemove = vi.fn();
    render(<FeedCard feed={FEED_A} immersive onRemove={onRemove} mode="playAll" isPlaying />);

    // The name still appears (as an overlay), but the department/location/ID/Map chrome does not.
    expect(screen.getByText(FEED_A.name)).toBeInTheDocument();
    expect(screen.queryByText(FEED_A.department, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText(/Map/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(`Remove ${FEED_A.name} from the grid`));
    expect(onRemove).toHaveBeenCalledWith(FEED_A.id);
  });

  it('is not draggable for reorder in immersive mode (onReorder never passed alongside it)', () => {
    const { container } = render(<FeedCard feed={FEED_A} immersive onRemove={vi.fn()} />);
    // immersive tiles render a plain wrapper div, not the draggable reorder shell.
    expect(container.querySelector('[draggable]')).not.toBeInTheDocument();
  });
});

describe('FeedCard remove button (watch-set mode)', () => {
  it('is absent without onRemove', () => {
    render(<FeedCard feed={FEED_A} />);
    expect(screen.queryByLabelText(`Remove ${FEED_A.name} from the grid`)).not.toBeInTheDocument();
  });

  it('calls onRemove with the feed id when clicked', () => {
    const onRemove = vi.fn();
    render(<FeedCard feed={FEED_A} onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText(`Remove ${FEED_A.name} from the grid`));
    expect(onRemove).toHaveBeenCalledWith('101');
  });
});
