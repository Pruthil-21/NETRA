import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DistrictAreaTree } from '@/components/tree/DistrictAreaTree';

const AREAS = [
  { id: 1, name: 'APC Area', district: 'Anand', district_id: 1, village: 'Village', taluka: 'Taluka', village_id: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Petlad Area', district: 'Anand', district_id: 1, village: 'Village', taluka: 'Taluka', village_id: 1, created_at: '2026-01-01T00:00:00Z' },
];

const CAMERAS: any[] = [
  { id: 101, name: 'Camera 01', dept: 'Anand', area_id: 1 },
  { id: 102, name: 'Camera 02', dept: 'Anand', area_id: 1 },
  { id: 103, name: 'Camera 03', dept: 'Anand', area_id: 2 },
];

describe('DistrictAreaTree', () => {
  it('renders fully expanded by default: districts, areas, and cameras all visible with no click needed', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.getByText('APC Area')).toBeInTheDocument();
    expect(screen.getByText('Petlad Area')).toBeInTheDocument();
    expect(screen.getByText('Camera 01')).toBeInTheDocument();
    expect(screen.getByText('Camera 02')).toBeInTheDocument();
    expect(screen.getByText('Camera 03')).toBeInTheDocument();
  });

  it('this default-expanded state is deterministic every render, not dependent on any stored state', () => {
    const { unmount } = render(
      <DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />
    );
    unmount();
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('APC Area')).toBeInTheDocument();
    expect(screen.getByText('Camera 01')).toBeInTheDocument();
  });

  it('clicking the district name both selects it and collapses it (toggle away from the expanded default)', () => {
    const onSelect = vi.fn();
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={onSelect} />);
    expect(screen.getByText('APC Area')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Anand'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'district', value: 'Anand' });
    expect(screen.queryByText('APC Area')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Anand'));
    expect(screen.getByText('APC Area')).toBeInTheDocument();
  });

  it('clicking an area name both selects it and collapses its cameras (toggle away from the expanded default)', () => {
    const onSelect = vi.fn();
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={onSelect} />);
    expect(screen.getByText('Camera 01')).toBeInTheDocument();

    fireEvent.click(screen.getByText('APC Area'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'area', value: 1 });
    expect(screen.queryByText('Camera 01')).not.toBeInTheDocument();
    expect(screen.queryByText('Camera 03')).toBeInTheDocument();

    fireEvent.click(screen.getByText('APC Area'));
    expect(screen.getByText('Camera 01')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Camera 01'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'camera', value: 101 });
  });

  it('shows an empty state for a district with no areas', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={[]} cameras={[]} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('No areas yet')).toBeInTheDocument();
  });

  it('shows cameras with no area_id under an "Unassigned" bucket, expanded by default', () => {
    const onSelect = vi.fn();
    const camerasWithOrphan = [...CAMERAS, { id: 104, name: 'Camera 04', dept: 'Anand', area_id: null }];
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={camerasWithOrphan} selected={null} onSelect={onSelect} />);
    expect(screen.getByText('Unassigned (1)')).toBeInTheDocument();
    expect(screen.getByText('Camera 04')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Camera 04'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'camera', value: 104 });
  });

  it('defaultCollapsed starts every level (districts, areas) closed, not just the top level', () => {
    render(
      <DistrictAreaTree
        districts={['Anand']}
        areas={AREAS}
        cameras={CAMERAS}
        selected={null}
        onSelect={() => {}}
        defaultCollapsed
      />
    );
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.queryByText('APC Area')).not.toBeInTheDocument();

    // Expanding the district must not dump every area's cameras open too --
    // areas start collapsed independently, the original bug this covers.
    fireEvent.click(screen.getByText('Anand'));
    expect(screen.getByText('APC Area')).toBeInTheDocument();
    expect(screen.queryByText('Camera 01')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('APC Area'));
    expect(screen.getByText('Camera 01')).toBeInTheDocument();
  });

  it('a per-district search icon opens a scoped box that filters just that district, by name', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    const localBox = screen.getByLabelText('Search cameras in Anand');
    expect(localBox).toBeInTheDocument();

    fireEvent.change(localBox, { target: { value: 'Camera 02' } });
    expect(screen.getByText('Camera 02')).toBeInTheDocument();
    expect(screen.queryByText('Camera 01')).not.toBeInTheDocument();
    expect(screen.queryByText('Camera 03')).not.toBeInTheDocument();

    // The universal bar is untouched by this -- still empty, no global filtering.
    expect(screen.getByLabelText('Search cameras by name')).toHaveValue('');
  });

  it('per-district search also matches by camera id, unlike the universal bar', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    fireEvent.change(screen.getByLabelText('Search cameras in Anand'), { target: { value: '103' } });

    expect(screen.getByText('Camera 03')).toBeInTheDocument();
    expect(screen.queryByText('Camera 01')).not.toBeInTheDocument();
  });

  it('per-district search also matches an area/area name', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    fireEvent.change(screen.getByLabelText('Search cameras in Anand'), { target: { value: 'petlad' } });

    expect(screen.getByText('Petlad Area')).toBeInTheDocument();
    expect(screen.queryByText('APC Area')).not.toBeInTheDocument();
  });

  it('closing the per-district search box removes it and restores the full district', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    fireEvent.change(screen.getByLabelText('Search cameras in Anand'), { target: { value: 'Camera 02' } });
    expect(screen.queryByText('Camera 01')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close search in Anand'));
    expect(screen.queryByPlaceholderText('Search in Anand…')).not.toBeInTheDocument();
    expect(screen.getByText('Camera 01')).toBeInTheDocument();
  });

  it('clicking anywhere outside an open search box closes it', () => {
    render(
      <div>
        <button>Somewhere else on screen</button>
        <DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />
      </div>
    );

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    expect(screen.getByPlaceholderText('Search in Anand…')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('Somewhere else on screen'));
    expect(screen.queryByPlaceholderText('Search in Anand…')).not.toBeInTheDocument();
  });

  it('pressing Escape closes an open search box', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    expect(screen.getByPlaceholderText('Search in Anand…')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search in Anand…')).not.toBeInTheDocument();
  });

  it('clicking inside the open search box itself does not close it', () => {
    render(<DistrictAreaTree districts={['Anand']} areas={AREAS} cameras={CAMERAS} selected={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByLabelText('Search cameras in Anand'));
    fireEvent.mouseDown(screen.getByPlaceholderText('Search in Anand…'));
    expect(screen.getByPlaceholderText('Search in Anand…')).toBeInTheDocument();
  });

  it('gives a area with no cameras no expand toggle, and clicking it only selects', () => {
    const onSelect = vi.fn();
    render(
      <DistrictAreaTree
        districts={['Anand']}
        areas={[{ id: 3, name: 'Empty Area', district: 'Anand', district_id: 1, village: 'Village', taluka: 'Taluka', village_id: 1, created_at: '2026-01-01T00:00:00Z' }]}
        cameras={[]}
        selected={null}
        onSelect={onSelect}
      />
    );
    expect(screen.queryByLabelText('Collapse Empty Area')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Expand Empty Area')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Empty Area'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'area', value: 3 });
  });
});
