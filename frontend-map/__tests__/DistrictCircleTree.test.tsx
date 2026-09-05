import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DistrictCircleTree } from '@/components/tree/DistrictCircleTree';

const CIRCLES = [
  { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Petlad Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
];

const CAMERAS: any[] = [
  { id: 101, name: 'Camera 01', dept: 'Anand', circle_id: 1 },
  { id: 102, name: 'Camera 02', dept: 'Anand', circle_id: 1 },
  { id: 103, name: 'Camera 03', dept: 'Anand', circle_id: 2 },
];

describe('DistrictCircleTree', () => {
  it('renders districts collapsed by default, with no circle nodes visible', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
  });

  it('expands to show circles on click, and selecting one calls onSelect', () => {
    const onSelect = vi.fn();
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    expect(screen.getByText('APC Circle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('APC Circle'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'circle', value: 1 });
  });

  it('clicking the district itself selects the whole district', () => {
    const onSelect = vi.fn();
    render(<DistrictCircleTree districts={['Anand']} circles={[]} cameras={[]} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Anand'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'district', value: 'Anand' });
  });

  it('shows an empty state for a district with no circles once expanded', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={[]} cameras={[]} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    expect(screen.getByText('No areas yet')).toBeInTheDocument();
  });

  it('expands a circle to reveal its cameras as leaves, and selecting one calls onSelect', () => {
    const onSelect = vi.fn();
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} cameras={CAMERAS} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    fireEvent.click(screen.getByLabelText('Expand APC Circle'));
    expect(screen.getByText('Camera 01')).toBeInTheDocument();
    expect(screen.getByText('Camera 02')).toBeInTheDocument();
    expect(screen.queryByText('Camera 03')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Camera 01'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'camera', value: 101 });
  });

  it('gives a circle with no cameras no expand toggle', () => {
    render(
      <DistrictCircleTree
        districts={['Anand']}
        circles={[{ id: 3, name: 'Empty Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' }]}
        cameras={[]}
        selected={null}
        onSelect={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    expect(screen.queryByLabelText('Expand Empty Circle')).not.toBeInTheDocument();
  });
});
